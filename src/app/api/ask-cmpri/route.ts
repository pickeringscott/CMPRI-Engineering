import { NextRequest, NextResponse } from "next/server";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AskContext, AskLanguage, AskResponse, AskResultItem, AskSource, AskTable, AskTableCell } from "@/lib/ask-cmpri/types";
import { profileIsChiefEngineer, profileIsEstablishedHoursChief } from "@/lib/server/roles";
import { requireUserAttempt } from "@/lib/server/auth";
import { validFirstName } from "@/lib/work-order-attribution";
import { applyAskContext, askContextSchema, askPermittedSources, asksToReformat, askText, explicitAskOrders, readAskSources, validAskRoom } from "@/lib/server/ask-cmpri-data";
import { answerAsk, askGeminiKey, canonicalAskManufacturer, knownPublicAskEquipment, planAsk, publicAskQuery, searchPublicAsk, type AskPlan } from "@/lib/server/ask-cmpri-gemini";
import { askPhotoSchema, beginAskAction, confirmAskAction } from "@/lib/server/ask-cmpri-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const headers = { "Cache-Control": "private, no-store" };
const fileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/), name: z.string().max(255), type: z.string().max(120),
  size: z.number().nonnegative().max(100 * 1024 * 1024), text: z.string().max(8500).optional(),
});
const requestSchema = z.union([
  z.object({ confirmationToken: z.string().min(15).max(22000), cancel: z.boolean().optional(), recover: z.boolean().optional() }),
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
      if (bytes > 360_000) {
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
  name: "Result", description: "Details", date: "Created", "created at": "Created", "updated at": "Updated", "room rank": "Room rank",
  habitacion: "Room", habitación: "Room", prioridad: "Priority", estado: "Ticket status", fecha: "Created", equipo: "Equipment", fuente: "Source",
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
  const sortBy = plan.sortBy.toLowerCase() === "date" && !knownFields.includes("Created") ? "Updated" : canonicalField(plan.sortBy);
  const needsSource = items.some((item) => item.href) || items.some((item) => item.record?.kind === "order") && items.some((item) => item.record?.kind !== "order");
  const chosen = [...new Set([...ids, ...(sortBy ? [sortBy] : [])].map(canonicalField))]
    .flatMap((preferred) => knownFields.find((known) => known.toLowerCase() === preferred.toLowerCase()) || []).slice(0, 10);
  const required = needsSource ? ["Result", "Details", "Source"] : [];
  if (!chosen.some((label) => label === "Work order" || label === "Result" || label === "Source") && items.some((item) => item.record || item.links?.length)) required.push("Source");
  const columns = [...chosen.filter((column) => !required.includes(column)).slice(0, 10 - required.length), ...required];
  if (!columns.length) columns.push("Result", "Details", "Source");
  const columnRows = items.map(({ id, title, text, source, record, href, facts, links }) => {
    const cells = Object.fromEntries(columns.map((field): [string, AskTableCell] => {
      if (field === "Result") return [field, record || href || links?.length ? { text: title, record, href, links: !columns.includes("Work order") ? links : undefined } : title];
      if (field === "Source") return [field, href || record || links?.length ? { text: source, href, record: columns.includes("Result") || columns.includes("Work order") && record?.kind === "order" ? undefined : record, links: !columns.includes("Result") && !columns.includes("Work order") ? links : undefined } : source];
      if (field === "Work order") return [field, record?.kind === "order" ? { text: record.label || "Open work order", record, links } : ""];
      if (field === "Reported issue" || field === "Details") {
        return [field, field === "Details" ? [text, ...(facts || []).map(({ label, value }) => label + " · " + value)].filter(Boolean).join(" · ") : record?.kind === "order" ? text || "" : ""];
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
    if (!left || !right) return !left && !right ? 0 : !left ? 1 : -1;
    const dates = ["Created", "Updated", "Due date", "Checkout date"].includes(sortColumn);
    const comparison = sortColumn === "Priority" ? priority.indexOf(left) - priority.indexOf(right)
      : sortColumn === "Checkout time" && !Number.isNaN(time(left)) && !Number.isNaN(time(right)) ? time(left) - time(right)
        : dates && Number.isFinite(Date.parse(left)) && Number.isFinite(Date.parse(right)) ? Date.parse(left) - Date.parse(right)
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
  if (/(?:[¿¡]|\b(?:habitaci[oó]n|inodoro|ducha|aver[ií]a|revisa|gotea|orden de trabajo|quiero|puedes|falla|fuga|arregl[oa]|notas del personal|no calienta|no funciona|busca|ubicaci[oó]n)\b)/i.test(question)) return "es";
  if (/^(?:in english|please respond in english)|\b(?:where is|what is|show me|which rooms|find the|create a work order)\b/i.test(question)) return "en";
  return fallback;
}

function fileItems(input: SearchInput): AskResultItem[] {
  return (input.files || []).map((file) => ({
    id: "file:" + file.id, title: askText(file.name, 180) || "Attached file",
    text: file.text ? askText(file.text, 8500) : "This file was attached. No readable text was supplied in this conversation.",
    source: "File supplied in this conversation", sourceType: "local",
    record: { kind: "file", id: file.id, label: "Open supplied file" },
  }));
}

function explicitEquipment(question: string, manufacturer: string, model: string) {
  if (!manufacturer || !model || !knownPublicAskEquipment(manufacturer, model)) return false;
  const upper = question.toUpperCase();
  const cleanedMaker = canonicalAskManufacturer(manufacturer).replace(/\b(?:appliances|electronics)\b/i, "").trim().toUpperCase();
  const terms = upper.split(/[^A-Z0-9._-]+/);
  const makerWords = cleanedMaker.split(/\s+/);
  const hasMaker = terms.some((word, index) => word === makerWords[0] && makerWords.every((part, offset) => part === terms[index + offset]));
  // Intentionally require the public identifiers in the request. Never trust a
  // model-suggested make or model inferred from arbitrary ticket/guest text.
  return terms.includes(model.toUpperCase()) && hasMaker &&
    !/\b(?:reservation|guest name|guest code|membership (?:id|number)|loyalty (?:id|code)|confirmation number)\b/i.test(question);
}

type ContextScope = { identity: { id: string }; hotelId: string };

function canonicalJson(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(object[key])).join(",") + "}";
}

function proof(context: AskContext, scope: ContextScope) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return "";
  const { contextProof: _proof, ...data } = context;
  void _proof;
  return createHmac("sha256", secret).update("cmpri-ask-context-v1\0").update(scope.hotelId).update("\0").update(scope.identity.id).update("\0").update(canonicalJson(data)).digest("base64url");
}

function attest(context: AskContext, scope: ContextScope): AskContext {
  const contextProof = proof(context, scope);
  return contextProof ? { ...context, contextProof } : context;
}

function acceptsContext(context: AskContext | undefined, scope: ContextScope) {
  if (!context?.contextProof) return false;
  const actual = Buffer.from(context.contextProof);
  const expected = Buffer.from(proof(context, scope));
  return expected.length > 0 && expected.length === actual.length && timingSafeEqual(actual, expected);
}

function createContext(input: SearchInput, plan: AskPlan, language: AskLanguage, fields?: string[], pending?: AskContext["pending"]): AskContext {
  const question = input.question.length > 650 ? input.question.slice(0, 650) : input.question;
  return {
    question, language, sources: plan.sources, rooms: plan.rooms,
    workOrders: plan.workOrders, terms: plan.terms, status: plan.status, roomIntent: plan.roomIntent, assignedOnly: plan.assignedOnly,
    locationNames: plan.locationNames, ticketStatus: plan.ticketStatus, checkoutAfter: plan.checkoutAfter, roomAvailability: plan.roomAvailability,
    rank: plan.rank, assetState: plan.assetState, fromDate: plan.fromDate, toDate: plan.toDate, noteAuthor: plan.noteAuthor,
    ...(plan.format === "default" ? {} : { format: plan.format }),
    ...(fields?.length ? { fields } : plan.fields.length ? { fields: plan.fields } : {}),
    ...(plan.sortBy ? { sortBy: plan.sortBy, sortDirection: plan.sortDirection } : {}),
    ...(pending ? { pending } : {}),
  };
}

function cancelsAction(question: string) {
  return /^(?:please\s+)?(?:never\s*mind|cancel(?: (?:that|it|the (?:edit|request|ticket|change)))?|disregard(?: that)?|forget it|stop that|don['’]t (?:do|submit|send|save) (?:that|it)|no[, ]+thanks|olv[ií]dalo|cancela(?:r|lo| la orden| la solicitud)?|no (?:lo )?(?:env[ií]es|guardes)|no[, ]+gracias)[.!?\s]*$/i.test(question.trim());
}

function directAction(question: string, field: AskPlan["candidateAction"]) {
  const raw = question.trim().replace(/^(?:please|por favor)\s+/i, "");
  if (/\b(?:personal notepad|personal note|nota personal|bloc personal)\b/i.test(raw)) return false;
  if (field === "create") {
    const request = /\b(?:create|submit|open|file|log|report|crea(?:r)?|env[ií]a(?:r)?|abre|reporta(?:r)?)\b.*\b(?:work order|ticket|maintenance request|orden(?: de trabajo)?|reporte)\b/i;
    if (request.test(raw) && !/\b(?:how|when|where|why|c[oó]mo|cu[aá]ndo|d[oó]nde)\b/i.test(raw)) return true;
    return !raw.endsWith("?") && /\b(?:won['’]t|doesn['’]t|is leaking|is out|is broken|broken|no funciona|no enciende|no descarga|no calienta|no corre|no enfr[ií]a|gotea|averiad[oa])\b/i.test(raw);
  }
  if (field === "staff-note") return /\b(?:post|announce|notify|tell|compart[eia]|publica(?:r)?|avisa(?:r)?|anuncia(?:r)?)\b.*\b(?:staff notes|staff-wide|all staff|everyone|the team|notas del personal|todo el personal|todos)\b/i.test(raw);
  if (field === "comment") return /\b(?:add|leave|post|a[ñn]ade|agrega|deja|comenta)\b.*\b(?:comment|note|comentario|nota)\b/i.test(raw);
  if (field === "status" || field === "priority") return /\b(?:set|mark|change|make|move|close|reopen|approve|escalate|lower|update|raise|cambia|marca|cierra|reabre|aprueba|sube|baja|pon)\b/i.test(raw)
    && !/^(?:what|where|why|when|which|is|was|does|should|how|qu[eé]|cu[aá]l|d[oó]nde|est[aá]|c[oó]mo|se puede)\b/i.test(raw);
  return false;
}

function continueAction(input: SearchInput, plan: AskPlan) {
  const previous = input.previous?.pending;
  const result = { plan, staffName: input.staffName || "", continued: false };
  if (!previous) return result;
  const reply = input.question.trim();
  const continuing = { ...plan, followUp: true, candidateAction: previous.field, actionValue: previous.value || plan.actionValue,
    requestedPriority: previous.priority || plan.requestedPriority, sources: input.previous?.sources || plan.sources };
  const staffName = input.staffName || previous.staffName || "";
  const answer = (amend: Partial<AskPlan>, name = staffName) => ({ plan: { ...continuing, ...amend }, staffName: name, continued: true });
  const otherTask = asksToReformat(reply) || /^(?:(?:please|por favor)\s+)*(?:find|where|what|which|show|search|can you|look up|busca|d[oó]nde|cu[aá]l|qu[eé]|muestra|encuentra|hello|goodbye|thanks|gracias)\b/i.test(reply);
  const proposedName = reply.replace(/^(?:i(?:['’]m| am)|my (?:first )?name is|me llamo|mi nombre es|soy)\s+/i, "");
  if (previous.needs === "staffName" && !otherTask && validFirstName(proposedName)
    && !/^(?:front\s*desk|staff|admin|skip|no(?:pe)?|yes|pass|salt|filters?|filtros?|microwaves?|microondas)$/i.test(proposedName) && proposedName.split(/\s+/).length <= 3) {
    return answer({}, input.staffName || proposedName);
  }
  const bareNumber = reply.match(/^(?:(?:room|habitaci[oó]n|wo|work order|ticket)\s*#?\s*)?(\d{1,8}[a-z]?)[?.!]*$/i)?.[1];
  if (bareNumber && (previous.needs === "room" || previous.needs === "workOrder")) {
    return answer(previous.needs === "room" ? { rooms: [bareNumber], workOrders: [] } : { rooms: [], workOrders: [bareNumber] });
  }
  if (previous.needs === "room" && !otherTask && plan.followUp && (plan.rooms.length || plan.locationNames?.length)) return answer({});
  if (previous.needs === "issue" && reply && !reply.endsWith("?") && !otherTask) return answer({ actionValue: reply });
  if (previous.needs === "value" && reply && !reply.endsWith("?") && !otherTask) {
    const value = plan.actionValue || reply;
    if (previous.field === "priority" && !/^(?:urgent|urgente|high|alta|medium|media|low|baja)$/i.test(value)) return result;
    if (previous.field === "status" && !/^(?:pending verification|open|in progress|completed|closed|will not do|abiert[oa]|en curso|completad[oa]|cerrad[oa])$/i.test(value)) return result;
    return answer({ actionValue: value });
  }
  if (previous.needs === "photo" && input.attachments?.length && !otherTask) {
    return answer({});
  }
  return result;
}

function normalizeActionValue(plan: AskPlan, question: string) {
  if (plan.candidateAction === "comment" || plan.candidateAction === "staff-note") {
    const quoted = question.match(/[“"]([\s\S]+?)[”"]/)?.[1];
    const remainder = question.match(/^[^:]{3,130}:\s*([\s\S]+)$/)?.[1];
    return quoted || remainder || plan.actionValue;
  }
  const equivalent: Record<string, string> = {
    urgente: "Urgent", alta: "High", media: "Medium", baja: "Low", abierta: "Open", abierto: "Open", "en curso": "In Progress",
    completada: "Completed", completado: "Completed", cerrada: "Closed", cerrado: "Closed", "pendiente de verificaci\u00f3n": "Pending Verification",
  };
  return equivalent[plan.actionValue.toLowerCase()] || plan.actionValue;
}

function confirmedTarget(plan: AskPlan, input: SearchInput, continued: boolean) {
  if (plan.candidateAction === "create") {
    const named = plan.locationNames || [];
    if (new Set([...plan.rooms, ...named]).size !== 1) return false;
    const lower = input.question.toLowerCase();
    const literalRoom = validAskRoom(input.question.replace(/[.?!]$/, "")) || validAskRoom(lower.match(/(?:^|\b(?:for|at|in|en|para|room|rm|habitaci[oó]n|cuarto)\s+)\s*#?(\d{1,4}[a-z]?)(?=$|[\s,.!?])/i)?.[1] || "");
    return !!literalRoom && plan.rooms.includes(literalRoom)
      || named.some((name) => lower.includes(name.toLowerCase().split(" / ")[0]))
      || !!(continued && input.previous?.contextProof && input.previous.pending?.needs !== "room"
        && (plan.rooms[0] && input.previous.rooms?.includes(plan.rooms[0]) || named[0] && input.previous.locationNames?.includes(named[0])));
  }
  if (!["status", "priority", "comment"].includes(plan.candidateAction) || plan.workOrders.length !== 1) return false;
  const request = plan.candidateAction === "comment" ? input.question.split(/[:“"]/u, 1)[0] : input.question;
  const [number] = explicitAskOrders(request);
  return number === plan.workOrders[0] || continued && input.previous?.pending?.needs === "workOrder"
    || !!input.previous?.contextProof && plan.followUp && input.previous.workOrders?.length === 1 && input.previous.workOrders[0] === plan.workOrders[0];
}

function requestedDownload(question: string, table: AskTable | undefined, items: AskResultItem[], title: string): AskResponse["downloads"] {
  if (!/\b(?:download|export|save as|descarga(?:r)?|exporta(?:r)?)\b/i.test(question) || !/\b(?:csv|txt|text|texto|table|tabla)\b/i.test(question)) return undefined;
  if (/\b(?:txt|text|texto)\b/i.test(question) && !/\bcsv\b/i.test(question)) {
    const content = [title, ...items.map(({ title: label, text, source, href, facts }) => [label, text, ...(facts || []).map((fact) => `${fact.label} · ${fact.value}`), source, href].filter(Boolean).join("\n"))].join("\n\n");
    return [{ id: "ask-results-txt", name: "CMPRI-search-results.txt", mimeType: "text/plain;charset=utf-8", content, encoding: "utf8" }];
  }
  if (!table) return undefined;
  const csv = (value: string) => `"${(/^[\s\x00-\x1f]*[=+\-@]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`;
  const rows = table.rows.map(({ cells }) => table.columns.map(({ id }) => {
    const row = cells[id];
    return csv(typeof row === "string" ? row : row?.href ? `${row.text} ${row.href}` : row?.text || "");
  }).join(","));
  const content = [table.columns.map(({ label }) => csv(label)).join(","), ...rows].join("\r\n");
  return [{ id: "ask-results-csv", name: "CMPRI-search-results.csv", mimeType: "text/csv;charset=utf-8", content, encoding: "utf8" }];
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAttempt(request);
  if (!auth.ok || auth.mcp) {
    return NextResponse.json({ error: "Sign in to use Ask CMPRI." }, { status: 401, headers });
  }
  const parsed = requestSchema.safeParse(await requestBody(request));
  if (!parsed.success) return NextResponse.json({ error: "Send a question of up to 1,000 characters, a supported attachment, or a current confirmation." }, { status: 400, headers });
  if ("confirmationToken" in parsed.data) {
    const { confirmationToken, cancel, recover } = parsed.data;
    const { result, status } = await confirmAskAction(request, auth, confirmationToken, { cancel, recover });
    return NextResponse.json(result.context ? { ...result, context: attest(result.context, auth.principal) } : result, { status, headers });
  }

  const prior = parsed.data.previous;
  const trusted = acceptsContext(prior, auth.principal);
  const previous = trusted ? prior : prior && { ...prior, pending: undefined, evidence: undefined, contextProof: undefined, publicEquipment: undefined, focus: undefined, webIntent: undefined };
  const language = questionLanguage(parsed.data.question, previous?.language || parsed.data.language || "en");
  if (cancelsAction(parsed.data.question)) return NextResponse.json({
    title: language === "es" ? "Solicitud cancelada" : "Request cancelled",
    summary: language === "es" ? "Se descartó la solicitud pendiente." : "The pending request was discarded.",
    context: attest({ language }, auth.principal),
  } satisfies AskResponse, { headers });
  if (!askGeminiKey()) return NextResponse.json({ error: "Ask CMPRI is not configured for this environment." }, { status: 503, headers });
  const usesAttachments = !parsed.data.question && Boolean(parsed.data.attachments?.length) && previous?.pending?.needs === "photo";
  const input = { ...parsed.data, previous, question: parsed.data.question || (usesAttachments ? "" : language === "es" ? "Usa los archivos adjuntos en esta conversación." : "Use the attached files in this conversation.") };
  const chief = profileIsChiefEngineer(auth.principal.profile) || profileIsEstablishedHoursChief(auth.principal.profile);
  let es = language === "es";
  try {
    const budget = AbortSignal.any([request.signal, AbortSignal.timeout(38_000)]);
    const allowed = askPermittedSources(auth.principal);
    const { contextProof: _proof, evidence: _evidence, ...priorPlan } = previous || {};
    void _proof; void _evidence;
    const planned = await planAsk(input.question, previous ? priorPlan : undefined, language, allowed, chief, budget);
    const initial = continueAction(input, { ...planned });
    const responseLanguage = initial.continued || !input.question ? language : planned.language || language;
    es = responseLanguage === "es";
    const actionAllowed = initial.continued || directAction(input.question, initial.plan.candidateAction);
    if (!actionAllowed) initial.plan.candidateAction = "none";
    initial.plan.actionValue = normalizeActionValue(initial.plan, input.question);
    const plan = applyAskContext(initial.plan, input.question, previous);
    const reformat = trusted && plan.followUp && asksToReformat(input.question);
    if (reformat) plan.webIntent = previous?.webIntent || "none";
    const equipmentReply = /^\s*(?:[a-z]{1,3}\s*[- ]?\s*\d{1,4}(?:\s*[- ]?\s*[a-z]{1,3}\s*\d{1,4})?|lo\s*fl)\s*[.?!]?\s*$/i.test(input.question);
    if (trusted && (reformat || plan.followUp || equipmentReply) && previous?.publicEquipment) {
      const retained = previous.publicEquipment;
      plan.manufacturer ||= retained.manufacturer;
      plan.model ||= retained.model;
      if (equipmentReply && (previous.focus === "error-code" || previous.webIntent === "manual")) {
        plan.webIntent = "error-code";
        plan.errorCode = input.question.trim().replace(/[.?!]$/, "");
      } else if (reformat && previous.webIntent === "error-code") plan.errorCode ||= retained.errorCode || "";
    }
    if (plan.workOrders.length && (!plan.sources.length || explicitAskOrders(input.question).length) && !plan.sources.includes("orders")) plan.sources = (["orders", ...plan.sources] as AskSource[]).slice(0, 6);
    if (!reformat && actionAllowed && !plan.workOrders.length && previous?.contextProof && plan.followUp && /\b(?:that ticket|that work order|that one|esa orden|ese ticket)\b/i.test(input.question)) {
      const ids = previous.evidence?.filter((id) => id.startsWith("order:")) || [];
      if (ids.length === 1) {
        const id = ids[0].slice(6);
        plan.workOrders = [id];
        input.previous = { ...previous, workOrders: [id] };
      }
    }
    const { items: internal, orders, locations, assets, missing } = await readAskSources(request, auth, plan, reformat ? previous?.evidence : undefined);
    if (/\b(?:designated model|model(?:s)? should be|models? belong|standard model|modelo designado)\b/i.test(input.question)) missing.push(es
      ? "CMPRI no tiene un registro verificado de modelos designados para esas habitaciones."
      : "CMPRI has no verified designated-model record for these rooms.");
    const flatQuestion = input.question.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const photoRequested = /\b(?:attach|include|add|adjunt\w*|inclu\w*|anad\w*|with|con)\b[\s\S]*\b(?:photo|picture|image|foto|imagen)\b|\b(?:foto|imagen)\s+adjunta\b/i.test(flatQuestion)
      || !!(initial.continued && previous?.pending?.photoRequired);
    const action = beginAskAction({
      plan, principal: auth.principal, orders, locations, language: responseLanguage,
      staffName: initial.staffName, attachments: input.attachments || [], photoRequested,
      targetExplicit: confirmedTarget(plan, input, initial.continued),
    });
    if (action.proposal || action.unavailable) {
      const result: AskResponse = {
        title: action.proposal ? es ? "Revisa el cambio" : "Review proposed change" : es ? "Cambio no disponible" : "Change unavailable",
        summary: action.proposal ? action.proposal.label : action.unavailable || "",
        ...(action.proposal ? { proposal: action.proposal } : {}),
        context: attest(createContext(input, plan, responseLanguage), auth.principal),
      };
      return NextResponse.json(result, { headers });
    }

    const qualifiedAssets = assets.filter((asset) => asset.manufacturer && asset.model_number &&
      (asset.documentation_verified || knownPublicAskEquipment(asset.manufacturer, asset.model_number)));
    const plannedMake = canonicalAskManufacturer(plan.manufacturer), plannedModel = plan.model.trim().toUpperCase();
    const explicitlyNamed = explicitEquipment(input.question, plannedMake, plannedModel);
    const retained = trusted && (plan.followUp || equipmentReply || reformat) ? previous?.publicEquipment : undefined;
    const exactAssets = qualifiedAssets.filter((asset) => (!plannedMake || canonicalAskManufacturer(asset.manufacturer || "") === plannedMake)
      && (!plannedModel || asset.model_number?.trim().toUpperCase() === plannedModel));
    const distinctEquipment = new Map(exactAssets.map((asset) => [`${canonicalAskManufacturer(asset.manufacturer || "")}/${asset.model_number?.trim().toUpperCase()}`, asset]));
    const asset = distinctEquipment.size === 1 ? [...distinctEquipment.values()][0] : undefined;
    const trustedRetained = retained && (!plannedMake || retained.manufacturer === plannedMake) && (!plannedModel || retained.model === plannedModel) ? retained : undefined;
    const publicEquipment: AskContext["publicEquipment"] = explicitlyNamed ? { manufacturer: plannedMake, model: plannedModel }
      : asset ? { manufacturer: canonicalAskManufacturer(asset.manufacturer || ""), model: asset.model_number?.trim().toUpperCase() || "" } : trustedRetained;
    const questionForWeb = reformat && previous?.question ? previous.question : input.question;
    const webQuery = publicAskQuery({
      ...plan, manufacturer: publicEquipment?.manufacturer || "", model: publicEquipment?.model || "",
      errorCode: plan.errorCode,
    }, questionForWeb, !!(asset?.documentation_verified && asset.model_number?.trim().toUpperCase() === publicEquipment?.model));
    const queries = new Set<string>();
    if (webQuery) queries.add(webQuery);
    if (plan.webIntent === "manufacturer" && plan.followUp && !explicitlyNamed && !plannedModel) {
      const reportedAssets = new Set(orders.map((order) => order.asset_id));
      for (const asset of qualifiedAssets) {
        if (!reportedAssets.has(asset.id) || queries.size >= 3) continue;
        const query = publicAskQuery({
          ...plan, manufacturer: asset.manufacturer || "", model: asset.model_number || "", errorCode: "",
        }, input.question, Boolean(asset.documentation_verified));
        if (query) queries.add(query);
      }
    }
    const web: AskResultItem[] = [];
    if (queries.size) {
      const webDeadline = AbortSignal.any([budget, AbortSignal.timeout(9_000)]);
      const grounded = await Promise.allSettled([...queries].map((query) => searchPublicAsk(query, webDeadline)));
      if (grounded.some((result) => result.status === "rejected")) missing.push("Some manufacturer or other web sources are temporarily unavailable.");
      const links = new Set<string>();
      for (const result of grounded) {
        if (result.status !== "fulfilled") continue;
        for (const item of result.value) {
          if (!item.href || links.has(item.href)) continue;
          links.add(item.href);
          web.push({ ...item, id: `web:${createHash("sha256").update(item.href).digest("hex").slice(0, 24)}` });
        }
      }
    } else if (plan.webIntent !== "none") missing.push(es ? "No se pudo verificar una fuente pública para esos datos." : "No public source could be verified for those details.");
    if (queries.size && !web.length) {
      if ([...queries].some((query) => query.startsWith("National Weather Service"))) web.push({ id: "web-nws-tornado", title: es ? "Seguridad durante un tornado" : "Tornado safety", text: es
        ? "Busca refugio en el piso más bajo, en un cuarto interior, lejos de ventanas. Protege la cabeza y el cuello."
        : "Go to an interior room on the lowest floor, away from windows. Protect your head and neck.", source: "Web · National Weather Service", sourceType: "web", href: "https://www.weather.gov/safety/tornado", hrefLabel: es ? "Abrir instrucciones oficiales" : "Open official guidance" });
      else missing.push(es ? "No se encontró una fuente oficial del fabricante." : "No verified official manufacturer source was returned.");
    }

    let items = [...internal, ...fileItems(input), ...web];
    if (reformat && previous?.evidence?.length) {
      const available = new Map(items.map((item) => [item.id, item]));
      items = previous.evidence.flatMap((id) => available.get(id) || []);
      if (items.length !== previous.evidence.length) missing.push(es ? "Algunas fuentes anteriores ya no están disponibles." : "Some earlier sources are no longer available.");
    }
    if (action.clarification && chief) missing.push("The requested change is missing details and was not prepared.");
    const needsCode = plan.webIntent === "error-code" && !plan.errorCode;
    const needsEquipment = ["manual", "manufacturer", "error-code"].includes(plan.webIntent) && !publicEquipment && !queries.size;
    const focus = needsCode ? "error-code" as const : needsEquipment ? "equipment" as const : undefined;
    const contextFor = (fields?: string[], pending?: AskContext["pending"], evidence?: string[]) => attest({
      ...createContext(input, plan, responseLanguage, fields, pending), focus,
      ...(reformat && previous?.question ? { question: previous.question } : {}),
      ...(plan.webIntent !== "none" ? { webIntent: plan.webIntent } : {}),
      ...(publicEquipment?.manufacturer && publicEquipment.model ? { publicEquipment: { ...publicEquipment, ...(plan.errorCode && webQuery ? { errorCode: plan.errorCode } : {}) } } : {}),
      ...(evidence?.length ? { evidence: evidence.slice(0, 75) } : {}),
    }, auth.principal);
    const englishClarification = needsCode ? "What code is shown on the equipment display?" : "What is the make and model on the equipment label?";
    const spanishClarification = needsCode ? "¿Qué código aparece en la pantalla del equipo?" : "¿Cuál es la marca y el modelo que aparecen en la etiqueta del equipo?";
    const clarity = chief || reformat ? "" : action.clarification || (focus
      ? es ? spanishClarification : englishClarification : !items.length ? askText(plan.clarification, 200) : "");
    if (clarity) {
      return NextResponse.json({
        title: es ? "Un detalle más" : "One more detail",
        summary: clarity,
        question: clarity,
        context: contextFor(undefined, action.needs && plan.candidateAction !== "none" ? {
          field: plan.candidateAction, needs: action.needs, value: plan.actionValue,
          ...(plan.requestedPriority !== "default" ? { priority: plan.requestedPriority } : {}),
          ...(initial.staffName ? { staffName: initial.staffName } : {}),
          ...(photoRequested ? { photoRequired: true } : {}),
        } : undefined),
      } satisfies AskResponse, { headers });
    }
    if (/\b(?:download|export|descarga(?:r)?|exporta(?:r)?)\b/i.test(input.question) && /\b(?:csv|table|tabla)\b/i.test(input.question)) plan.format = "table";
    const rendered = reformat ? undefined : await answerAsk({ question: input.question, language: responseLanguage, chief, items, missing, signal: budget }).catch(() => undefined);
    const selectedIds = new Set(rendered?.itemIds || []);
    const selected = reformat || plan.format === "table" ? items : items.filter(({ id, sourceType }) => selectedIds.has(id) || sourceType === "web");
    const displayItems = selected.length || !items.length ? selected : items.slice(0, 12);
    const title = askText(rendered?.title, 160) || (es ? "Resultados de CMPRI" : "CMPRI results");
    const table = plan.format === "table" && displayItems.length ? tableFor(displayItems, plan, previous, title) : undefined;
    const downloads = requestedDownload(input.question, table, displayItems, title);
    const fallback = items.length ? es ? "Aquí están las fuentes disponibles." : "Here are the available sources."
      : es ? "No encontré datos verificados para esta búsqueda." : "No verified records matched this search.";
    const result: AskResponse = {
      title,
      summary: [askText(rendered?.summary, 1800) || fallback, ...(!rendered ? [...new Set(missing)].slice(0, 3) : [])].join(" "),
      items: displayItems,
      ...(plan.format !== "default" ? { format: plan.format } : {}),
      ...(table ? { table } : {}),
      ...(downloads ? { downloads } : {}),
      context: contextFor(table?.columns.map(({ label }) => label), undefined, displayItems.map(({ id }) => id)),
    };
    return NextResponse.json(result, { headers });
  } catch {
    return NextResponse.json({ error: es ? "Ask CMPRI no pudo completar la búsqueda. Inténtalo de nuevo." : "Ask CMPRI could not complete the request. Try again." }, { status: 502, headers });
  }
}
