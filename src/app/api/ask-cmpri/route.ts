import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { AskContext, AskLanguage, AskResponse, AskResultItem, AskTable, AskTableCell } from "@/lib/ask-cmpri/types";
import { profileIsChiefEngineer } from "@/lib/server/roles";
import { requireUserAttempt } from "@/lib/server/auth";
import { validFirstName } from "@/lib/work-order-attribution";
import { applyAskContext, askContextSchema, askPermittedSources, askText, readAskSources } from "@/lib/server/ask-cmpri-data";
import { answerAsk, askGeminiKey, knownPublicAskEquipment, planAsk, publicAskQuery, searchPublicAsk, type AskPlan } from "@/lib/server/ask-cmpri-gemini";
import { askPhotoSchema, beginAskAction, confirmAskAction } from "@/lib/server/ask-cmpri-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const headers = { "Cache-Control": "private, no-store" };
const fileSchema = z.object({
  id: z.string().max(100), name: z.string().max(255), type: z.string().max(120),
  size: z.number().nonnegative().max(100 * 1024 * 1024), text: z.string().max(8500).optional(),
});
const requestSchema = z.union([
  z.object({ confirmationToken: z.string().min(15).max(12000) }),
  z.object({
    question: z.string().trim().max(1000),
    language: z.enum(["en", "es"]).optional(),
    previous: askContextSchema.optional(),
    files: z.array(fileSchema).max(8).optional(),
    attachments: z.array(askPhotoSchema).max(12).optional(),
    staffName: z.string().trim().max(80).optional(),
  }).refine((input) => input.question || input.files?.length || input.attachments?.length),
]);
type SearchInput = Exclude<z.infer<typeof requestSchema>, { confirmationToken: string }>;

async function requestBody(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  let bytes = 0;
  let raw = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 95_000) {
        await reader.cancel();
        return undefined;
      }
      raw += decoder.decode(value, { stream: true });
    }
    return JSON.parse(raw + decoder.decode()) as unknown;
  } catch { return undefined; }
  finally { reader.releaseLock(); }
}

const columnAliases: Record<string, string> = {
  room: "Room", "room number": "Room", availability: "Room availability", issue: "Reported issue", "reported issue": "Reported issue",
  ticket: "Work order", "work order": "Work order", status: "Ticket status", "repair state": "Repair status", "repair status": "Repair status",
  technician: "Assigned to", "checkout": "Checkout time", "time": "Checkout time",
  name: "Result", "description": "Details",
};

function canonicalField(value: string) {
  return columnAliases[value.toLowerCase()] || value;
}

function tableFor(items: AskResultItem[], plan: AskPlan, previous: AskContext | undefined, title: string): AskTable {
  const knownFields = ["Result", "Reported issue", "Details", "Source", "Work order", ...new Set(items.flatMap((item) => (item.facts || []).map((entry) => entry.label)))];
  const ids = plan.fields.length ? plan.fields
    : plan.followUp && previous?.fields?.length ? previous.fields
      : items.some((item) => item.record?.kind === "order")
        ? ["Room", "Reported issue", "Work order", "Ticket status", "Repair status"]
        : items.some((item) => item.facts?.some(({ label }) => label === "Checkout time"))
          ? ["Room", "Checkout time", "Source"]
          : ["Result", "Details", "Source"];
  const sortBy = canonicalField(plan.sortBy);
  const columns = [...new Set([...ids, ...(sortBy ? [sortBy] : [])].map(canonicalField))]
    .flatMap((preferred) => knownFields.find((known) => known.toLowerCase() === preferred.toLowerCase()) || []).slice(0, 10);
  if (!columns.length) columns.push("Result", "Details", "Source");
  const columnRows = items.map(({ id, title, text, source, record, href, facts }) => {
    const cells = Object.fromEntries(columns.map((field): [string, AskTableCell] => {
      if (field === "Result") return [field, record ? { text: title, record } : title];
      if (field === "Source") return [field, href ? { text: source, href } : source];
      if (field === "Work order") return [field, record?.kind === "order" ? { text: record.label || "Open work order", record } : ""];
      if (field === "Reported issue" || field === "Details") {
        return [field, field === "Details" ? [text, ...(facts || []).map(({ label, value }) => label + " · " + value)].filter(Boolean).join(" · ") : text || ""];
      }
      return [field, facts?.find((entry) => entry.label === field)?.value || ""];
    }));
    return { id, cells };
  });
  const sortColumn = columns.find((field) => field.toLowerCase() === sortBy.toLowerCase());
  const priority = ["Low", "Medium", "High", "Urgent"];
  const time = (value: string) => {
    const match = value.match(/^(\d{1,2}):(\d{2})\s([AP])M$/i);
    return match ? (Number(match[1]) % 12 + (match[3].toUpperCase() === "P" ? 12 : 0)) * 60 + Number(match[2]) : Number.NaN;
  };
  if (sortColumn) columnRows.sort((a, b) => {
    const aCell = a.cells[sortColumn];
    const bCell = b.cells[sortColumn];
    const left = typeof aCell === "string" ? aCell : aCell.text;
    const right = typeof bCell === "string" ? bCell : bCell.text;
    const comparison = sortColumn === "Priority" ? priority.indexOf(left) - priority.indexOf(right)
      : sortColumn === "Checkout time" && !Number.isNaN(time(left)) && !Number.isNaN(time(right)) ? time(left) - time(right)
        : left.localeCompare(right, undefined, { numeric: true });
    const desc = plan.sortDirection === "desc" || plan.sortDirection === "none" && sortColumn === "Priority";
    return desc ? -comparison : comparison;
  });
  return {
    caption: title,
    columns: columns.map((field) => ({ id: field, label: field })),
    rows: columnRows,
  };
}

function questionLanguage(question: string, fallback: AskLanguage) {
  return /(?:[¿¡]|\b(?:habitaci[oó]n|inodoro|ducha|aver[ií]a|revisa|gotea|orden de trabajo|quiero|puedes|falla|fuga|arregl[oa]|notas del personal)\b)/i.test(question)
    ? "es" : fallback;
}

function fileItems(input: SearchInput): AskResultItem[] {
  return (input.files || []).slice(0, 8).map((file, index) => ({
    id: "local:" + index, title: askText(file.name, 180) || "Attached file",
    text: file.text ? askText(file.text, 3800) : "This file was attached. No readable text was supplied in this conversation.",
    source: "File supplied in this conversation", sourceType: "local",
  }));
}

function explicitEquipment(question: string, manufacturer: string, model: string) {
  if (!manufacturer || !model || !knownPublicAskEquipment(manufacturer, model)) return false;
  const upper = question.toUpperCase();
  const cleanedMaker = manufacturer.replace(/\b(?:appliances|electronics)\b/i, "").trim().toUpperCase();
  const terms = upper.split(/[^A-Z0-9._-]+/);
  const makerWords = cleanedMaker.split(/\s+/);
  const hasMaker = terms.some((word, index) => word === makerWords[0] && makerWords.every((part, offset) => part === terms[index + offset]));
  // Intentionally require the public identifiers in the request. Never trust a
  // model-suggested make or model inferred from arbitrary ticket/guest text.
  return terms.includes(model.toUpperCase()) && hasMaker &&
    !/\b(?:reservation|guest name|guest code|membership (?:id|number)|loyalty (?:id|code)|confirmation number)\b/i.test(question);
}

function createContext(input: SearchInput, plan: AskPlan, language: AskLanguage, fields?: string[], pending?: AskContext["pending"]): AskContext {
  const question = input.question.length > 650 ? input.question.slice(0, 650) : input.question;
  return {
    question, language, sources: plan.sources, rooms: plan.rooms,
    workOrders: plan.workOrders, terms: plan.terms, status: plan.status, roomIntent: plan.roomIntent, assignedOnly: plan.assignedOnly,
    ...(plan.format === "default" ? {} : { format: plan.format }),
    ...(fields?.length ? { fields } : plan.fields.length ? { fields: plan.fields } : {}),
    ...(plan.sortBy ? { sortBy: plan.sortBy, sortDirection: plan.sortDirection } : {}),
    ...(pending ? { pending } : {}),
  };
}

function continueAction(input: SearchInput, plan: AskPlan) {
  const previous = input.previous?.pending;
  if (!previous) return { plan, staffName: input.staffName || "" };
  const reply = input.question.trim();
  if (previous.needs === "staffName" && validFirstName(reply) && reply.split(/\s+/).length <= 3 && !/\b(?:show|search|where|what|which|hello|cancel|close)\b/i.test(reply)) {
    return {
      plan: { ...plan, followUp: true, candidateAction: previous.field, actionValue: previous.value || plan.actionValue },
      staffName: input.staffName || reply,
    };
  }
  const bareNumber = reply.match(/^(?:(?:room|habitaci[oó]n|wo|work order|ticket)\s*#?\s*)?(\d{1,8}[a-z]?)[?.!]*$/i)?.[1];
  if (bareNumber && (previous.needs === "room" || previous.needs === "workOrder")) {
    return {
      plan: {
        ...plan, followUp: true, candidateAction: previous.field, actionValue: previous.value || plan.actionValue,
        ...(previous.needs === "room" ? { rooms: [bareNumber], workOrders: [] } : { rooms: [], workOrders: [bareNumber] }),
      },
      staffName: input.staffName || "",
    };
  }
  if (previous.needs === "issue" && reply.length <= 1000 && reply && !/\?$/.test(reply) && !/^(?:find|where|show|search|cancel)\b/i.test(reply)) {
    return { plan: { ...plan, followUp: true, candidateAction: previous.field, actionValue: reply }, staffName: input.staffName || "" };
  }
  if (previous.needs === "photo" && input.attachments?.length) {
    return {
      plan: { ...plan, followUp: true, candidateAction: previous.field, actionValue: previous.value || plan.actionValue },
      staffName: input.staffName || "",
    };
  }
  return { plan, staffName: input.staffName || "" };
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAttempt(request);
  if (!auth.ok || auth.mcp) {
    return NextResponse.json({ error: "Sign in to use Ask CMPRI." }, { status: 401, headers });
  }
  const parsed = requestSchema.safeParse(await requestBody(request));
  if (!parsed.success) return NextResponse.json({ error: "Send a question or a valid confirmation." }, { status: 400, headers });
  if ("confirmationToken" in parsed.data) {
    const { result, status } = await confirmAskAction(request, auth, parsed.data.confirmationToken);
    return NextResponse.json(result, { status, headers });
  }
  if (!askGeminiKey()) return NextResponse.json({ error: "Ask CMPRI is not configured for this environment." }, { status: 503, headers });

  const input = parsed.data.question ? parsed.data : {
    ...parsed.data,
    question: parsed.data.previous?.language === "es" || parsed.data.language === "es"
      ? "Usa los archivos adjuntos en esta conversación."
      : "Use the attached files in this conversation.",
  };
  const chief = profileIsChiefEngineer(auth.principal.profile);
  const language = questionLanguage(input.question, input.language || input.previous?.language || "en");
  const es = language === "es";
  try {
    const budget = AbortSignal.any([request.signal, AbortSignal.timeout(38_000)]);
    const allowed = askPermittedSources(auth.principal);
    const initial = continueAction(input, await planAsk(input.question, input.previous, language, allowed, chief, budget));
    const plan = applyAskContext(initial.plan, input.question, input.previous);
    const { items: internal, orders, locations, assets, missing } = await readAskSources(request, auth, plan);
    const action = beginAskAction({
      plan, principal: auth.principal, orders, locations, language,
      staffName: initial.staffName, photoCount: (input.attachments || []).filter((item) => /^image\//i.test(item.type) || /\.(?:jpg|jpeg|png|webp|heic|avif)$/i.test(item.name)).length,
      photoRequested: /\b(?:attach|include|add|adjunt\w+|inclu\w+|a[nñ]ad\w+)\b.*\b(?:photo|picture|image|foto|imagen)\b/i.test(input.question)
        || input.previous?.pending?.needs === "photo",
    });
    if (action.proposal || action.unavailable) {
      const result: AskResponse = {
        title: action.proposal ? es ? "Revisa el cambio" : "Review proposed change" : es ? "Cambio no disponible" : "Change unavailable",
        summary: action.proposal ? action.proposal.label : action.unavailable || "",
        ...(action.proposal ? { proposal: action.proposal } : {}),
        context: createContext(input, plan, language),
      };
      return NextResponse.json(result, { headers });
    }

    const qualifiedAssets = assets.filter((asset) => asset.manufacturer && asset.model_number &&
      (asset.documentation_verified_at || knownPublicAskEquipment(asset.manufacturer, asset.model_number)));
    const bestAsset = qualifiedAssets.find((asset) => plan.model && asset.model_number?.toLowerCase() === plan.model.toLowerCase())
      || (qualifiedAssets.length === 1 ? qualifiedAssets[0] : undefined);
    const maker = bestAsset?.manufacturer || plan.manufacturer;
    const equipment = bestAsset?.model_number || plan.model;
    const hasExplicitEquipment = explicitEquipment(input.question, maker, equipment);
    const isAuthoritative = Boolean(bestAsset || hasExplicitEquipment);
    const webQuery = publicAskQuery({
      ...plan, manufacturer: isAuthoritative ? maker : "", model: isAuthoritative ? equipment : "",
      errorCode: plan.errorCode && input.question.toLowerCase().replace(/[\s-]+/g, "").includes(plan.errorCode.toLowerCase().replace(/[\s-]+/g, "")) ? plan.errorCode : "",
    }, input.question, Boolean(bestAsset?.documentation_verified_at));
    const queries = new Set<string>();
    if (webQuery) queries.add(webQuery);
    if (plan.webIntent === "manufacturer" && plan.followUp && !hasExplicitEquipment) {
      const reportedAssets = new Set(orders.map((order) => order.asset_id));
      for (const asset of qualifiedAssets) {
        if (!reportedAssets.has(asset.id) || queries.size >= 3) continue;
        const query = publicAskQuery({
          ...plan, manufacturer: asset.manufacturer || "", model: asset.model_number || "", errorCode: "",
        }, input.question, Boolean(asset.documentation_verified_at));
        if (query) queries.add(query);
      }
    }
    const web: AskResultItem[] = [];
    if (queries.size) {
      const grounded = await Promise.allSettled([...queries].map((query) => searchPublicAsk(query, budget)));
      if (grounded.some((result) => result.status === "rejected")) missing.push("Some manufacturer or other web sources are temporarily unavailable.");
      const links = new Set<string>();
      for (const result of grounded) {
        if (result.status !== "fulfilled") continue;
        for (const item of result.value) {
          if (!item.href || links.has(item.href)) continue;
          links.add(item.href);
          web.push({ ...item, id: `web-${web.length}` });
        }
      }
    } else if (plan.webIntent !== "none") missing.push("An exact, public equipment identifier or supported safety topic is needed to verify a public source.");

    const items = [...internal, ...fileItems(input), ...web];
    if (action.clarification && chief) missing.push("The requested change is missing details and was not prepared.");
    const needsCode = plan.webIntent === "error-code" && !plan.errorCode;
    const clarity = chief ? "" : action.clarification || (needsCode
      ? es ? "¿Qué código aparece en la pantalla del equipo?" : "What code is shown on the equipment display?"
      : !items.length ? askText(plan.clarification, 200) : "");
    if (clarity) {
      return NextResponse.json({
        title: es ? "Un detalle más" : "One more detail",
        summary: clarity,
        question: clarity,
        context: createContext(input, plan, language, undefined, action.needs && plan.candidateAction !== "none" ? {
          field: plan.candidateAction, needs: action.needs, value: plan.actionValue,
          ...(plan.requestedPriority !== "default" ? { priority: plan.requestedPriority } : {}),
        } : undefined),
      } satisfies AskResponse, { headers });
    }
    const rendered = await answerAsk({ question: input.question, language, chief, items, missing, signal: budget });
    const selectedIds = new Set(rendered.itemIds);
    const selected = plan.format === "table" ? items : items.filter(({ id, sourceType }) => selectedIds.has(id) || sourceType === "web");
    const displayItems = selected.length || !items.length ? selected : items.slice(0, 12);
    const title = askText(rendered.title, 160) || "Ask CMPRI";
    const table = plan.format === "table" && displayItems.length ? tableFor(displayItems, plan, input.previous, title) : undefined;
    const result: AskResponse = {
      title,
      summary: askText(rendered.summary, 1800) || (es ? "Estos son los resultados disponibles." : "These are the available results."),
      items: displayItems,
      ...(plan.format !== "default" ? { format: plan.format } : {}),
      ...(table ? { table } : {}),
      context: createContext(input, plan, language, table?.columns.map(({ label }) => label)),
    };
    return NextResponse.json(result, { headers });
  } catch {
    return NextResponse.json({ error: es ? "Ask CMPRI no pudo completar la búsqueda. Inténtalo de nuevo." : "Ask CMPRI could not complete the request. Try again." }, { status: 502, headers });
  }
}
