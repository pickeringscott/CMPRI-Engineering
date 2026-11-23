import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { AskResponse, AskResultItem } from "@/lib/ask-cmpri/types";
import { normalizeManualKnowledge } from "@/lib/manual-knowledge";
import { reportedDiagnosticCode } from "@/lib/manual-source";
import { allows } from "@/lib/server/access";
import { answerAsk, askGeminiKey, publicAskQuery, searchPublicAsk } from "@/lib/server/ask-cmpri-gemini";
import { requireUserAttempt } from "@/lib/server/auth";
import { profileIsChiefEngineer, profileIsEstablishedHoursChief, roleKey } from "@/lib/server/roles";
import { loadUploadedAssetGuide } from "@/lib/server/uploaded-asset-guide";
import { workOrderReader } from "@/lib/server/work-order-reader";
import { parseTicketHistory } from "@/lib/ticket-note-presentation";
import { isUuid } from "@/lib/uuid";
import { canReadWorkOrder } from "@/lib/work-order-read-policy";
import { deriveTroubleshootingChecklistContext } from "@/lib/work-orders/troubleshooting-checklist";

export const runtime = "nodejs";
export const maxDuration = 60;

const headers = { "Cache-Control": "private, no-store", Vary: "Authorization" };
const inputSchema = z.object({
  workOrderId: z.string().refine(isUuid), assetId: z.string().refine(isUuid),
  language: z.enum(["en", "es"]).default("en"), web: z.boolean().default(true),
}).strict();
const privateIdentifier = /\b(?:guest (?:name|code|id)|reservation|loyalty|confirmation (?:number|code)|membership (?:number|id)|hu[ée]sped|reserva|membres[ií]a)\b/i;

export async function POST(request: NextRequest) {
  const auth = await requireUserAttempt(request);
  if (!auth.ok || auth.mcp) return NextResponse.json({ error: "Sign in to use Ask CMPRI." }, { status: 401, headers });
  const { principal, admin } = auth;
  if (!allows(principal, "view_work_orders") || !allows(principal, "view_dashboard") || !allows(principal, "view_pm")) {
    return NextResponse.json({ error: "Work-order and equipment guide access are required." }, { status: 403, headers });
  }
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Select the saved work order and equipment." }, { status: 400, headers });
  const { workOrderId, assetId, language, web } = parsed.data;
  const es = language === "es";
  if (!askGeminiKey()) return NextResponse.json({ error: es ? "Ask CMPRI no está configurado en este entorno." : "Ask CMPRI is not configured for this environment." }, { status: 503, headers });

  try {
    const order = await admin.from("work_orders").select("id,hotel_id,asset_id,location_id,issue,reporter_notes,notes,action_root_cause,technician_name")
      .eq("hotel_id", principal.hotelId).eq("id", workOrderId).maybeSingle();
    if (order.error) throw new Error("Work order unavailable");
    if (!order.data || !canReadWorkOrder(workOrderReader(principal), order.data)) return NextResponse.json({ error: "The work order is unavailable to this account." }, { status: 404, headers });
    if (order.data.asset_id !== assetId) return NextResponse.json({ error: "Save the selected equipment on this work order before using Ask CMPRI." }, { status: 409, headers });

    const asset = await admin.from("assets").select("id,hotel_id,location_id,active,manufacturer,model_family,model_number,serial_number,documentation_key,documentation_revision_id,documentation_verified_at,pdf_import_links")
      .eq("hotel_id", principal.hotelId).eq("id", assetId).maybeSingle();
    if (asset.error) throw new Error("Equipment unavailable");
    if (!asset.data || asset.data.active === false) {
      return NextResponse.json({ error: "This equipment is unavailable for the saved work order." }, { status: 404, headers });
    }

    const budget = AbortSignal.any([request.signal, AbortSignal.timeout(48_000)]);
    const guide = await loadUploadedAssetGuide(admin, asset.data).catch(() => null);
    const manual = guide?.documentation_status === "verified" ? normalizeManualKnowledge(guide.manualKnowledge) : null;
    const checklist = manual ? deriveTroubleshootingChecklistContext({ ...order.data, asset: asset.data }, manual) : undefined;
    const manualItems = (checklist?.steps || []).slice(0, 12).map((step): AskResultItem => ({
      id: `guide:${step.id}`, title: step.label, sourceType: "internal", source: "CMPRI · Verified equipment manual",
      facts: step.sourcePages?.length ? [{ label: "Source pages", value: step.sourcePages.join(", ") }] : undefined,
    }));
    const equipment = { manufacturer: asset.data.manufacturer || "", model: asset.data.model_number || "" };
    const verified = Boolean(manual?.source?.verified || !asset.data.documentation_revision_id && asset.data.documentation_verified_at);
    const publicDiagnosticText = [order.data.issue, order.data.reporter_notes].filter(Boolean).join("\n")
      .split(/[;\n.!?]+/).filter(clause => !privateIdentifier.test(clause)).join("\n");
    const code = web ? reportedDiagnosticCode(publicDiagnosticText) : null;
    const diagnosticQuery = code ? publicAskQuery({ ...equipment, webIntent: "error-code", errorCode: code }, `Error code ${code}`, verified) : null;
    const query = web ? diagnosticQuery || publicAskQuery({ ...equipment, webIntent: "manual", errorCode: "" }, "Official manufacturer troubleshooting manual", verified) : null;
    const webItems = query ? await searchPublicAsk(query, budget).catch(() => []) : [];
    const technician = String(order.data.technician_name || "").trim().toLowerCase();
    const findings = parseTicketHistory(order.data.notes || "").filter(({ kind, actor, authorRole, text }) => {
      const role = roleKey(authorRole);
      return kind === "note" && (role === "technician" || role === "engineer" || Boolean(technician && actor.trim().toLowerCase() === technician) || /^Original technician notes:/i.test(text));
    }).slice(-5).map(({ text }) => text.slice(0, 240));
    if (order.data.action_root_cause?.trim()) findings.push(order.data.action_root_cause.trim().slice(0, 350));
    const findingsItem: AskResultItem[] = findings.length ? [{ id: "ticket-findings", title: es ? "Hallazgos técnicos registrados" : "Recorded technician findings", text: findings.join("\n"), source: es ? "CMPRI · Esta orden de trabajo" : "CMPRI · This work order", sourceType: "internal" }] : [];
    if (!manualItems.length && !webItems.length) return NextResponse.json({
      title: es ? "Fuentes de diagnóstico" : "Troubleshooting sources",
      summary: web
        ? es ? "No se encontró una fuente verificada del fabricante para el modelo seleccionado." : "No verified manufacturer source was found for the selected model."
        : es ? "El manual verificado no contiene pasos que coincidan con esta incidencia." : "The verified manual has no matching steps for this issue.",
      ...(findingsItem.length ? { items: findingsItem } : {}),
    } satisfies AskResponse, { headers });
    const question = [
      es ? "Resume las fuentes para este diagnóstico. Distingue el manual verificado de los resultados web. Los hallazgos técnicos describen lo que ya se probó. Sugiere solo medidas respaldadas por un manual o por el fabricante."
        : "Summarize these troubleshooting sources. Distinguish the verified equipment manual from web results. Use technician findings to account for work already tried. Give only next steps supported by a manual or manufacturer source.",
      `Equipment: ${asset.data.manufacturer || ""} ${asset.data.model_number || ""}`,
      `Reported symptom: ${String(order.data.issue || "").slice(0, 650)}`,
    ].join("\n");
    const chief = profileIsChiefEngineer(principal.profile) || profileIsEstablishedHoursChief(principal.profile);
    const answer = await answerAsk({ question, language, chief, items: [...manualItems, ...webItems, ...findingsItem], missing: [], signal: budget });
    const display = [...findingsItem, ...webItems];
    return NextResponse.json({ title: answer.title, summary: answer.summary, ...(display.length ? { items: display } : {}) } satisfies AskResponse, { headers });
  } catch {
    return NextResponse.json({ error: es ? "No se pudo completar el diagnóstico con Ask CMPRI." : "Ask CMPRI could not complete this troubleshooting request." }, { status: 502, headers });
  }
}
