import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import type { AskContext, AskLanguage, AskProposal, AskResponse } from "@/lib/ask-cmpri/types";
import { allows, canSetFrontDeskWorkOrderPriority, type Principal } from "@/lib/server/access";
import type { AuthAttempt } from "@/lib/server/auth";
import { isFrontDesk, isSubmitOnlyRole, profileHasRole, profileIsChiefEngineer, profileIsEstablishedHoursChief, roleKey } from "@/lib/server/roles";
import { isUuid } from "@/lib/uuid";
import { validFirstName } from "@/lib/work-order-attribution";
import { formatWorkOrder } from "@/lib/work-order-reference.js";
import { workOrderEditableFields, workOrderStatusEffect } from "@/lib/work-order-edit-policy";
import { canAccessWorkOrderByAssignment } from "@/lib/server/work-order-assignment";
import { manualPreviewReadOnly } from "@/lib/server/manual-preview";
import { isSupportedWorkOrderMedia } from "@/lib/work-order-media";
import { STAFF_FILE_BUCKET } from "@/lib/staff-note-media";
import { TICKET_MEDIA_ES } from "@/lib/i18n/ticket-media";
import { askOrderItem, askText, type AskLocation, type AskOrder } from "./ask-cmpri-data";
import type { AskPlan } from "./ask-cmpri-gemini";

type Authorized = Extract<AuthAttempt, { ok: true }>;
const priorities = ["Low", "Medium", "High", "Urgent"] as const;
const statuses = ["Pending Verification", "Open", "In Progress", "Completed", "Closed", "Will Not Do"] as const;
const signingContext = "cmpri-ask-confirmation:v1:";
const validMinutes = 12;
const attachmentSigningContext = "cmpri-ask-attachment:v1:";
const attachmentValidityMs = 7 * 86_400_000;
export const askPhotoSchema = z.object({
  uploadId: z.string().uuid(), name: z.string().min(1).max(255), type: z.string().max(120),
  size: z.number().int().positive().max(100 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type AskPhoto = z.infer<typeof askPhotoSchema>;
const actionSchema = z.object({
  actor: z.string(),
  hotel: z.string(),
  expires: z.number().int(),
  requestId: z.string(),
  language: z.enum(["en", "es"]),
  field: z.enum(["create", "status", "priority", "comment", "staff-note"]),
  id: z.string(),
  value: z.string(),
  room: z.string(),
  revision: z.number().int(),
  priority: z.enum(["", ...priorities]),
  staffName: z.string(),
  attachments: z.array(askPhotoSchema).max(8).default([]),
});
type Action = z.infer<typeof actionSchema>;
type ProposalResult = { proposal?: AskProposal; clarification?: string; needs?: NonNullable<AskContext["pending"]>["needs"]; unavailable?: string };

function receipt(payload: string, context = signingContext) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Ask CMPRI confirmation is unavailable.");
  return createHmac("sha256", secret).update(context).update(payload).digest();
}

function sign(action: Action) {
  return signedPayload(action, signingContext);
}

function signedPayload(value: object, context: string) {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return payload + "." + receipt(payload, context).toString("base64url");
}

function verifiedPayload(token: string, context: string): unknown {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  try {
    const expected = receipt(payload, context);
    const provided = Buffer.from(signature, "base64url");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch { return null; }
}

export function verifyAskConfirmation(token: string, principal: Principal, allowExpiredRecovery = false): Action | null {
  const parsed = actionSchema.safeParse(verifiedPayload(token, signingContext));
  if (!parsed.success) return null;
  const action = parsed.data;
  if (action.actor !== principal.identity.id || action.hotel !== principal.hotelId || !isUuid(action.requestId)) return null;
  return action.expires > Date.now() || (allowExpiredRecovery && action.expires + attachmentValidityMs > Date.now()) ? action : null;
}

export function verifyAskAttachment(token: string, principal: Principal, workOrderId: string, input: AskPhoto) {
  const schema = z.object({ actor: z.string(), hotel: z.string(), id: z.string(), expires: z.number(), attachments: z.array(z.string()).max(8) });
  const parsed = schema.safeParse(verifiedPayload(token, attachmentSigningContext));
  if (!parsed.success) return false;
  const { actor, hotel, id, expires, attachments } = parsed.data;
  return actor === principal.identity.id && hotel === principal.hotelId && id === workOrderId && expires > Date.now()
    && Boolean(input.sha256 && attachments.includes(attachmentDigest(input)));
}

function attachmentDigest(file: AskPhoto) {
  return createHash("sha256").update(JSON.stringify([file.uploadId, file.name, file.type, file.size, file.sha256])).digest("base64url");
}

export function canAskEditOrder(principal: Principal, entry: AskOrder, field: "comment" | "priority" | "status", value: string) {
  if (entry.hotel_id !== principal.hotelId || !allows(principal, "view_work_orders")) return false;
  if (field === "comment") return allows(principal, "add_work_order_notes");
  if (field === "priority" && canSetFrontDeskWorkOrderPriority(principal)) return true;

  const chief = profileIsChiefEngineer(principal.profile) || profileIsEstablishedHoursChief(principal.profile);
  const role = chief ? "Chief Engineer" : principal.profile.role;
  if (!canAccessWorkOrderByAssignment(role, principal.profile.full_name, entry)) return false;
  const canEdit = allows(principal, "edit_tickets");
  const canReview = allows(principal, "review_tickets");
  if (!workOrderEditableFields({ role, canEdit, canReview, unassigned: !askText(entry.technician_name), canClaimUnassigned: false }).includes(field)) return false;
  if (field === "status") {
    if (roleKey(role) === "technician" && !chief && !["Open", "In Progress", "Completed"].includes(value)) return false;
    if (!canEdit && canReview && (entry.status !== "Pending Verification" || !["Open", "Will Not Do"].includes(value))) return false;
    if (value === "Closed" && !allows(principal, "close_tickets")) return false;
    if (!chief && entry.status === "Closed" && value !== "Closed" &&
      (!allows(principal, "reopen") || !["In Progress", "Completed"].includes(value))) return false;
  }
  const effect = workOrderStatusEffect(entry, field === "status" ? { status: value } : {});
  return chief || effect.status !== "In Progress" || Boolean(effect.technician);
}

function pickValue<T extends string>(options: readonly T[], value: string) {
  return options.find((option) => option.toLowerCase() === value.trim().toLowerCase());
}

function localizedOrderValue(value: string, language: AskLanguage) {
  return language === "es" ? TICKET_MEDIA_ES[value] || (value === "Open" ? "Abierta" : value === "Will Not Do" ? "No se realizará" : value) : value;
}

export function beginAskAction(input: {
  plan: AskPlan; principal: Principal; orders: AskOrder[]; locations: AskLocation[]; language: AskLanguage;
  staffName: string; attachments?: AskPhoto[]; photoRequested: boolean; targetExplicit?: boolean;
}): ProposalResult {
  const { plan, principal, orders, locations, language, staffName } = input;
  if (plan.candidateAction === "none") return {};
  const es = language === "es";
  const action: Action = {
    actor: principal.identity.id, hotel: principal.hotelId, expires: Date.now() + validMinutes * 60_000,
    requestId: randomUUID(), language, field: plan.candidateAction, id: "", value: "", room: "", revision: 0, priority: "", staffName, attachments: [],
  };
  let from = "";
  let to = "";
  let label = "";
  const effects: string[] = [];
  if (action.field === "create") {
    if (!allows(principal, "submit")) return { unavailable: es ? "Tu cuenta no puede crear órdenes de trabajo." : "Your account cannot create work orders." };
    if (locations.length !== 1 || !input.targetExplicit || (!plan.rooms.length && !plan.locationNames?.length)) return { needs: "room", clarification: es ? "¿En qué habitación ocurrió?" : "Which room is this for?" };
    if (!askText(plan.actionValue)) return { needs: "issue", clarification: es ? "¿Qué problema hay en ese lugar?" : "What problem should the work order describe?" };
    if (isFrontDesk(principal.profile.role) && !validFirstName(staffName)) return { needs: "staffName", clarification: es ? "¿Qué nombre de pila debe aparecer en la orden?" : "What first name should appear on the work order?" };
    const attachments = [...new Map((input.attachments || []).filter(file => file.sha256 && isSupportedWorkOrderMedia(file.name, file.type)).map(file => [file.uploadId, file])).values()].slice(0, 8);
    const hasPhoto = attachments.some(file => isSupportedWorkOrderMedia(file.name, file.type)?.startsWith("image/"));
    if (input.photoRequested && !hasPhoto) return {
      needs: "photo", clarification: es ? "¿Puedes adjuntar la foto?" : "Can you attach the photo?",
    };
    if (attachments.length && (!allows(principal, "view_work_orders") || !allows(principal, "add_work_order_notes"))) {
      return { unavailable: es ? "Tu cuenta no puede adjuntar archivos a la orden." : "Your account cannot attach files to the work order." };
    }
    const location = locations[0];
    action.id = location.id;
    action.room = location.room_number || location.name;
    action.value = askText(plan.actionValue, 1000);
    action.priority = (canSetFrontDeskWorkOrderPriority(principal) || allows(principal, "edit_tickets") || allows(principal, "review_tickets")) ? pickValue(priorities, plan.requestedPriority) || "" : "";
    action.attachments = attachments;
    label = es ? "Crear orden de trabajo" : "Create work order";
    to = [action.room, action.value, localizedOrderValue(action.priority, language)].filter(Boolean).join(" · ");
    if (isSubmitOnlyRole(principal.profile.role)) effects.push(es ? "Se enviará para verificación de Ingeniería." : "This will be submitted for Engineering verification.");
    if (attachments.length) effects.push((es ? "Archivos incluidos" : "Included attachments") + " · " + attachments.map(file => file.name).join(", "));
  } else if (action.field === "staff-note") {
    if (!askText(plan.actionValue)) return { needs: "value", clarification: es ? "¿Qué quieres publicar en Notas del personal?" : "What announcement should appear in Staff Notes?" };
    if (profileHasRole(principal.profile, "front_desk") && !validFirstName(staffName)) return { needs: "staffName", clarification: es ? "¿Qué nombre debe aparecer en la publicación?" : "What name should appear on the Staff Notes post?" };
    action.value = askText(plan.actionValue, 4000);
    label = es ? "Publicar en Notas del personal" : "Post to Staff Notes";
    to = action.value;
  } else {
    if (!input.targetExplicit || orders.length !== 1) return { needs: "workOrder", clarification: es ? "¿Qué número de orden de trabajo quieres cambiar?" : "Which work-order number should change?" };
    const order = orders[0];
    const value = action.field === "status" ? pickValue(statuses, plan.actionValue)
      : action.field === "priority" ? pickValue(priorities, plan.actionValue) : askText(plan.actionValue, 1000);
    if (!value) return { needs: "value", clarification: es ? "¿Qué cambio quieres hacer en la orden?" : "What change should I propose for this work order?" };
    if (!canAskEditOrder(principal, order, action.field, value)) return { unavailable: es ? "Tu cuenta no puede aplicar ese cambio a esta orden." : "Your account cannot make that change to this work order." };
    const orderLabel = formatWorkOrder(order.display_id);
    action.id = order.id;
    action.revision = Number(order.revision);
    action.value = value;
    from = action.field === "comment" ? "" : String(action.field === "priority" ? order.ranker_base_priority ?? order.priority : order.status);
    if (from === value) return { unavailable: orderLabel + (es ? " ya tiene ese valor." : " already has that value.") };
    if (action.field === "priority" && value === order.priority && from !== order.priority) {
      return { unavailable: es
        ? `${orderLabel} ya muestra ${value} por la clasificación de la habitación. CMPRI conserva una prioridad seleccionada de ${from}.`
        : `${orderLabel} already displays ${value} because of room ranking. Its selected priority remains ${from}.` };
    }
    to = action.field === "comment" ? value : localizedOrderValue(value, language);
    if (action.field !== "comment") from = localizedOrderValue(from, language);
    if (action.field === "status") {
      const effect = workOrderStatusEffect(order, { status: value });
      if (effect.restoredTechnician) effects.push((es ? "Se restaurará la asignación a" : "Assignment will be restored to") + " " + effect.restoredTechnician);
      if (value === "Completed") effects.push(es ? "La reparación quedará completada y pendiente de cierre." : "The repair will be completed and will await closure.");
    }
    if (action.field === "priority" && order.ranker_base_priority && order.ranker_base_priority !== order.priority) {
      effects.push(es ? "El rango de la habitación puede afectar la prioridad que se muestra." : "Room ranking may affect the displayed priority.");
    }
    label = (action.field === "comment" ? es ? "Añadir comentario a " : "Add comment to "
      : action.field === "priority" ? es ? "Cambiar prioridad de " : "Change priority on "
        : es ? "Cambiar estado de " : "Change status on ") + orderLabel;
  }
  return { proposal: { token: sign(action), id: action.id, field: action.field, label, from, to, ...(effects.length ? { effects } : {}), ...(action.attachments.length ? { attachments: action.attachments } : {}) } };
}

function delegate(incoming: NextRequest, pathname: string, method: "POST" | "PATCH", body: unknown) {
  return new NextRequest(new URL(pathname, incoming.nextUrl.origin), {
    method,
    headers: { Authorization: incoming.headers.get("authorization") || "", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Confirmation = { result: AskResponse; status: number };
type SavedTarget = { id: string; display_id: string; status?: string };
const confirmationProjection = "id,display_id,hotel_id,room,issue,status,priority,ranker_base_priority,revision,technician_name,last_assigned_technician_name,created_by";

function confirmationError(action: Action, status: number, en: string, es: string): Confirmation {
  return { status, result: { title: action.language === "es" ? "Cambio no confirmado" : "Change not confirmed", summary: action.language === "es" ? es : en } };
}

function savedCreation(action: Action, row: SavedTarget): Confirmation {
  const label = formatWorkOrder(row.display_id);
  const es = action.language === "es";
  const engineeringVerification = row.status === "Pending Verification";
  const attachments = action.attachments.length ? {
    attachments: action.attachments,
    attachmentToken: signedPayload({
      actor: action.actor, hotel: action.hotel, id: row.id,
      expires: action.expires + attachmentValidityMs, attachments: action.attachments.map(attachmentDigest),
    }, attachmentSigningContext),
  } : {};
  return {
    result: {
      title: engineeringVerification
        ? es ? "Solicitud enviada para verificación de Ingeniería" : "Request submitted for Engineering verification"
        : es ? "Orden de trabajo creada" : "Work order created",
      summary: label + (row.status ? " · " + localizedOrderValue(row.status, action.language) : ""),
      savedOrder: { id: row.id, displayId: label, ...attachments },
      items: [{ id: "order:" + row.id, title: label, source: "CMPRI · Work orders", sourceType: "internal", record: { kind: "order", id: row.id, label } }],
      context: { language: action.language, sources: ["orders"], workOrders: [row.id] },
    },
    status: 200,
  };
}

function editResult(action: Action, row: AskOrder, warning?: boolean): Confirmation {
  const es = action.language === "es";
  const parts = [formatWorkOrder(row.display_id)];
  if (action.field === "comment") parts.push(es ? "Comentario guardado" : "Comment added");
  if (action.field === "status") {
    parts.push(localizedOrderValue(row.status, action.language));
    if (row.technician_name) parts.push((es ? "Asignado a " : "Assigned to ") + row.technician_name);
  }
  if (action.field === "priority") {
    const base = askText(row.ranker_base_priority);
    if (base && base !== row.priority) parts.push((es ? "Prioridad seleccionada: " : "Selected priority: ") + localizedOrderValue(base, action.language),
      (es ? "Prioridad mostrada: " : "Displayed priority: ") + localizedOrderValue(row.priority, action.language));
    else parts.push(localizedOrderValue(row.priority, action.language));
  }
  if (warning) parts.push(es ? "Vuelve a abrir la orden para actualizar sus detalles." : "Reopen the work order to refresh its details.");
  return {
    status: 200, result: {
      title: es ? "Orden actualizada" : "Work order updated",
      summary: parts.join(" · "),
      items: [askOrderItem(row, false)],
      context: { language: action.language, sources: ["orders"], workOrders: [action.id] },
    },
  };
}

function savedStaffNote(action: Action, id: string): Confirmation {
  return { status: 200, result: {
    title: action.language === "es" ? "Publicado en Notas del personal" : "Posted to Staff Notes",
    summary: action.language === "es" ? "La nota se guardó." : "The note was saved.",
    items: [{ id, title: action.language === "es" ? "Nota del personal" : "Staff note", source: "CMPRI · Staff Notes", sourceType: "internal",
      record: { kind: "staffNote", id, label: action.language === "es" ? "Abrir nota" : "Open note" } }],
  } };
}

async function currentAskOrder(auth: Authorized, id: string) {
  return await auth.admin.from("work_orders").select(confirmationProjection)
    .eq("hotel_id", auth.principal.hotelId).eq("id", id).maybeSingle();
}

export async function confirmAskAction(
  request: NextRequest, auth: Authorized, token: string, options: { cancel?: boolean; recover?: boolean } = {},
): Promise<Confirmation> {
  const verified = verifyAskConfirmation(token, auth.principal, true);
  if (!verified) return { result: { title: "Confirmation unavailable", summary: "Open the current suggestion again before confirming." }, status: 409 };
  const action = verified;
  const isFresh = action.expires > Date.now();
  if (!isUuid(action.actor) || !isUuid(action.hotel)) return confirmationError(action, 403, "An active property account is required.", "Se requiere una cuenta activa de la propiedad.");
  if (manualPreviewReadOnly()) return confirmationError(action, 403, "Changes are disabled in this read-only preview.", "Los cambios están desactivados en esta vista de solo lectura.");
  const storage = auth.admin.storage.from(STAFF_FILE_BUCKET);
  const prefix = `ask-confirmations/v1/${action.hotel}/${action.actor}/${action.requestId}`;
  const cancelled = (): Confirmation => ({ status: 200, result: { title: action.language === "es" ? "Cambio cancelado" : "Change cancelled", summary: action.language === "es" ? "No se guardó ningún cambio." : "No change was saved." } });
  const unconfirmed = () => confirmationError(action, 409,
    "Check the work order or Staff Notes before starting another change. Ask CMPRI has not verified this outcome.",
    "Revisa la orden de trabajo o Notas del personal antes de iniciar otro cambio. Ask CMPRI no ha verificado el resultado.");
  const unavailable = () => confirmationError(action, 503, "Confirmation could not be checked. Try again.", "No se pudo comprobar la confirmación. Inténtalo de nuevo.");

  async function readMarker(key: string): Promise<"confirm" | "cancel" | "saved" | null> {
    const stored = await storage.download(`${prefix}/${key}`);
    if (stored.error) {
      const error = stored.error as { status?: string; statusCode?: string; originalError?: { status?: number }; message?: string };
      if (String(error.statusCode || error.status || error.originalError?.status) === "404" || /not found|NoSuchKey/i.test(error.message || "")) return null;
      throw stored.error;
    }
    const value = await stored.data?.text();
    if (value === "confirm" || value === "cancel" || value === "saved") return value;
    throw new Error("Invalid confirmation marker");
  }

  async function recover(): Promise<Confirmation> {
    if (action.field === "staff-note") {
      const previous = await auth.admin.from("cmpri_staff_notes").select("id").eq("hotel_id", action.hotel)
        .eq("author_user_id", action.actor).eq("request_id", action.requestId).maybeSingle();
      return previous.error ? unavailable() : previous.data ? savedStaffNote(action, String(previous.data.id)) : unconfirmed();
    }
    const previous = await currentAskOrder(auth, action.field === "create" ? action.requestId : action.id);
    if (previous.error) return unavailable();
    if (!previous.data || !allows(auth.principal, "view_work_orders")) return unconfirmed();
    const row = previous.data as AskOrder;
    if (action.field === "create") return row.created_by === action.actor ? savedCreation(action, row) : unconfirmed();
    return await readMarker("result") === "saved" ? editResult(action, row) : unconfirmed();
  }

  try {
    const claim = await readMarker("claim");
    if (claim === "cancel") return options.cancel ? cancelled() : confirmationError(action, 409, "This proposal was cancelled.", "Esta propuesta se canceló.");
    if (claim === "confirm") return await recover();
    if (options.recover || !isFresh) return confirmationError(action, 409, "This change was never confirmed or has expired. Review a new proposal.", "Este cambio no se confirmó o ha caducado. Revisa una propuesta nueva.");
    if (!options.cancel && action.field !== "create" && action.field !== "staff-note") {
      const current = await currentAskOrder(auth, action.id);
      if (current.error) return unavailable();
      if (!current.data || !canAskEditOrder(auth.principal, current.data as AskOrder, action.field, action.value)) {
        return confirmationError(action, 403, "Your account cannot make this change to the work order.", "Tu cuenta no puede aplicar este cambio a la orden.");
      }
      if (current.data.revision !== action.revision) return confirmationError(action, 409, "This work order changed. Review a fresh proposal.", "La orden de trabajo cambió. Revisa una propuesta nueva.");
    }
    const claimed = await storage.upload(`${prefix}/claim`, options.cancel ? "cancel" : "confirm", { upsert: false, contentType: "text/plain" });
    if (claimed.error) {
      const now = await readMarker("claim");
      return now === "cancel" ? options.cancel ? cancelled() : confirmationError(action, 409, "This proposal was cancelled.", "Esta propuesta se canceló.")
        : now === "confirm" ? await recover() : unavailable();
    }
    if (options.cancel) return cancelled();
    const committed = await applyConfirmedAction(request, auth, action);
    if (committed.status === 200 && action.field !== "create" && action.field !== "staff-note") {
      // The ticket is already committed. A marker outage cannot turn that success into a failed edit.
      await storage.upload(`${prefix}/result`, "saved", { upsert: false, contentType: "text/plain" }).catch(() => undefined);
    }
    return committed;
  } catch {
    return unavailable();
  }
}

async function applyConfirmedAction(request: NextRequest, auth: Authorized, action: Action): Promise<Confirmation> {
  const es = action.language === "es";
  let response: Response;
  switch (action.field) {
    case "create": {
      if (!allows(auth.principal, "submit")) return { result: { title: "Work-order permission required", summary: "Your account cannot submit this work order." }, status: 403 };
      const { POST } = await import("@/app/api/work-orders/route");
      response = await POST(delegate(request, "/api/work-orders", "POST", {
        creation_id: action.requestId,
        ...(action.staffName ? { staff_first_name: action.staffName } : {}),
        orders: [{ location_id: action.id, issue: action.value, ...(action.priority ? { priority: action.priority } : {}) }],
      }));
      break;
    }
    case "staff-note": {
      const { POST } = await import("@/app/api/staff-notes/route");
      response = await POST(delegate(request, "/api/staff-notes", "POST", { body: action.value, requestId: action.requestId, staffName: action.staffName }));
      break;
    }
    case "comment": {
      const { POST } = await import("@/app/api/work-orders/[id]/notes/route");
      const pathname = "/api/work-orders/" + encodeURIComponent(action.id) + "/notes";
      response = await POST(delegate(request, pathname, "POST", { expected_revision: action.revision, notes: [action.value] }), { params: Promise.resolve({ id: action.id }) });
      break;
    }
    default: {
      const { PATCH } = await import("@/app/api/work-orders/[id]/route");
      const pathname = "/api/work-orders/" + encodeURIComponent(action.id);
      response = await PATCH(delegate(request, pathname, "PATCH", { expected_revision: action.revision, [action.field]: action.value }), { params: Promise.resolve({ id: action.id }) });
    }
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const summary = typeof body.error === "string" ? body.error.slice(0, 350) : es ? "CMPRI no pudo confirmar el cambio." : "CMPRI could not confirm the change.";
    return { result: { title: es ? "Cambio no confirmado" : "Change not confirmed", summary }, status: response.status };
  }
  if (action.field === "create") {
    const row = (body.work_orders as { id: string; display_id: string; status?: string }[] | undefined)?.[0];
    if (!row?.id) return { result: { title: "Creation not confirmed", summary: "Check the work-order list before retrying." }, status: 502 };
    return savedCreation(action, row);
  }
  if (action.field === "staff-note") {
    return typeof body.id === "string" ? savedStaffNote(action, body.id) : confirmationError(action, 502, "Check Staff Notes before retrying.", "Revisa Notas del personal antes de volver a intentarlo.");
  }
  if (body.saved === true) {
    const label = es ? "Abrir orden de trabajo" : "Open work order";
    return { status: 200, result: {
      title: es ? "Orden actualizada" : "Work order updated",
      summary: es ? "Se guardó el cambio. Vuelve a abrir la orden antes de hacer más cambios." : "Your change was saved. Reopen the work order before making more changes.",
      items: [{ id: "order:" + action.id, title: es ? "Orden de trabajo" : "Work order", source: "CMPRI · Work orders", sourceType: "internal",
        record: { kind: "order", id: action.id, label } }],
      context: { language: action.language, sources: ["orders"], workOrders: [action.id] },
    } };
  }
  const row = body.workOrder as AskOrder | undefined;
  return row ? editResult(action, row, Boolean(body.warning)) : confirmationError(action, 502, "Check the work order before retrying.", "Revisa la orden de trabajo antes de volver a intentarlo.");
}
