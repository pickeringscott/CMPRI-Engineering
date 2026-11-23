import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import type { AskContext, AskLanguage, AskProposal, AskResponse } from "@/lib/ask-cmpri/types";
import { allows, canSetFrontDeskWorkOrderPriority, type Principal } from "@/lib/server/access";
import type { AuthAttempt } from "@/lib/server/auth";
import { isFrontDesk, profileHasRole, profileIsChiefEngineer, profileIsEstablishedHoursChief, roleKey } from "@/lib/server/roles";
import { isUuid } from "@/lib/uuid";
import { validFirstName } from "@/lib/work-order-attribution";
import { formatWorkOrder } from "@/lib/work-order-reference.js";
import { workOrderEditableFields } from "@/lib/work-order-edit-policy";
import { canAccessWorkOrderByAssignment } from "@/lib/server/work-order-assignment";
import { askOrderItem, askText, type AskLocation, type AskOrder } from "./ask-cmpri-data";
import type { AskPlan } from "./ask-cmpri-gemini";

type Authorized = Extract<AuthAttempt, { ok: true }>;
const priorities = ["Low", "Medium", "High", "Urgent"] as const;
const statuses = ["Pending Verification", "Open", "In Progress", "Completed", "Closed", "Will Not Do"] as const;
const signingContext = "cmpri-ask-confirmation:v1:";
const validMinutes = 12;
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
});
type Action = z.infer<typeof actionSchema>;
type ProposalResult = { proposal?: AskProposal; clarification?: string; needs?: NonNullable<AskContext["pending"]>["needs"]; unavailable?: string };

export const askPhotoSchema = z.object({ name: z.string().max(255), type: z.string().max(120), size: z.number().int().nonnegative().max(100 * 1024 * 1024) });

function receipt(payload: string) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Ask CMPRI confirmation is unavailable.");
  return createHmac("sha256", secret).update(signingContext).update(payload).digest();
}

function sign(action: Action) {
  const payload = Buffer.from(JSON.stringify(action), "utf8").toString("base64url");
  return payload + "." + receipt(payload).toString("base64url");
}

export function verifyAskConfirmation(token: string, principal: Principal): Action | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  try {
    const expected = receipt(payload);
    const provided = Buffer.from(signature, "base64url");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    const action = actionSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (action.actor !== principal.identity.id || action.hotel !== principal.hotelId || action.expires <= Date.now() || !isUuid(action.requestId)) return null;
    return action;
  } catch { return null; }
}

export function canAskEditOrder(principal: Principal, entry: AskOrder, field: "comment" | "priority" | "status", value: string) {
  if (entry.hotel_id !== principal.hotelId) return false;
  if (field === "comment") return allows(principal, "add_work_order_notes");
  if (field === "priority" && canSetFrontDeskWorkOrderPriority(principal)) return true;

  const chief = profileIsChiefEngineer(principal.profile) || profileIsEstablishedHoursChief(principal.profile);
  const role = chief ? "Chief Engineer" : principal.profile.role;
  if (!canAccessWorkOrderByAssignment(role, principal.profile.full_name, entry)) return false;
  const canEdit = allows(principal, "edit_tickets");
  const canReview = allows(principal, "review_tickets");
  if (!workOrderEditableFields({ role, canEdit, canReview, unassigned: !askText(entry.technician_name), canClaimUnassigned: false }).includes(field)) return false;
  if (field === "priority") return true;
  if (roleKey(role) === "technician" && !chief && !["Open", "In Progress", "Completed"].includes(value)) return false;
  if (!canEdit && canReview && (entry.status !== "Pending Verification" || !["Open", "Will Not Do"].includes(value))) return false;
  if (value === "Closed" && !allows(principal, "close_tickets")) return false;
  if (!chief && entry.status === "Closed" && value !== "Closed" &&
    (!allows(principal, "reopen") || !["In Progress", "Completed"].includes(value))) return false;
  return chief || value !== "In Progress" || Boolean(askText(entry.technician_name) || entry.status === "Closed" && askText(entry.last_assigned_technician_name));
}

function pickValue<T extends string>(options: readonly T[], value: string) {
  return options.find((option) => option.toLowerCase() === value.trim().toLowerCase());
}

export function beginAskAction(input: {
  plan: AskPlan; principal: Principal; orders: AskOrder[]; locations: AskLocation[]; language: AskLanguage;
  staffName: string; photoCount: number; photoRequested: boolean;
}): ProposalResult {
  const { plan, principal, orders, locations, language, staffName } = input;
  if (plan.candidateAction === "none") return {};
  const es = language === "es";
  const action: Action = {
    actor: principal.identity.id, hotel: principal.hotelId, expires: Date.now() + validMinutes * 60_000,
    requestId: randomUUID(), language, field: plan.candidateAction, id: "", value: "", room: "", revision: 0, priority: "", staffName,
  };
  let from = "";
  let to = "";
  let label = "";
  if (action.field === "create") {
    if (!allows(principal, "submit")) return { unavailable: es ? "Tu cuenta no puede crear órdenes de trabajo." : "Your account cannot create work orders." };
    if (locations.length !== 1 || !plan.rooms.length) return { needs: "room", clarification: es ? "¿En qué habitación ocurrió?" : "Which room is this for?" };
    if (!askText(plan.actionValue)) return { needs: "issue", clarification: es ? "¿Qué problema hay en ese lugar?" : "What problem should the work order describe?" };
    if (isFrontDesk(principal.profile.role) && !validFirstName(staffName)) return { needs: "staffName", clarification: es ? "¿Qué nombre de pila debe aparecer en la orden?" : "What first name should appear on the work order?" };
    if (input.photoRequested && input.photoCount < 1 && !profileIsChiefEngineer(principal.profile)) return {
      needs: "photo", clarification: es ? "¿Puedes adjuntar la foto?" : "Can you attach the photo?",
    };
    const location = locations[0];
    action.id = location.id;
    action.room = location.room_number || location.name;
    action.value = askText(plan.actionValue, 1000);
    action.priority = (canSetFrontDeskWorkOrderPriority(principal) || allows(principal, "edit_tickets")) ? pickValue(priorities, plan.requestedPriority) || "" : "";
    label = es ? "Crear orden de trabajo" : "Create work order";
    to = [action.room, action.value, action.priority, input.photoCount ? es ? `${input.photoCount} adjunto(s)` : `${input.photoCount} attachment(s)` : ""].filter(Boolean).join(" · ");
  } else if (action.field === "staff-note") {
    if (!askText(plan.actionValue)) return { needs: "value", clarification: es ? "¿Qué quieres publicar en Notas del personal?" : "What announcement should appear in Staff Notes?" };
    if (profileHasRole(principal.profile, "front_desk") && !validFirstName(staffName)) return { needs: "staffName", clarification: es ? "¿Qué nombre debe aparecer en la publicación?" : "What name should appear on the Staff Notes post?" };
    action.value = askText(plan.actionValue, 4000);
    label = es ? "Publicar en Notas del personal" : "Post to Staff Notes";
    to = action.value;
  } else {
    if (orders.length !== 1) return { needs: "workOrder", clarification: es ? "¿Qué número de orden de trabajo quieres cambiar?" : "Which work-order number should change?" };
    const order = orders[0];
    const value = action.field === "status" ? pickValue(statuses, plan.actionValue)
      : action.field === "priority" ? pickValue(priorities, plan.actionValue) : askText(plan.actionValue, 1000);
    if (!value) return { needs: "value", clarification: es ? "¿Qué cambio quieres hacer en la orden?" : "What change should I propose for this work order?" };
    if (!canAskEditOrder(principal, order, action.field, value)) return { unavailable: es ? "Tu cuenta no puede aplicar ese cambio a esta orden." : "Your account cannot make that change to this work order." };
    const orderLabel = formatWorkOrder(order.display_id);
    action.id = order.id;
    action.revision = Number(order.revision);
    action.value = value;
    from = action.field === "comment" ? "" : String(order[action.field]);
    if (from === value) return { unavailable: orderLabel + (es ? " ya tiene ese valor." : " already has that value.") };
    to = value;
    label = (action.field === "comment" ? es ? "Añadir comentario a " : "Add comment to "
      : action.field === "priority" ? es ? "Cambiar prioridad de " : "Change priority on "
        : es ? "Cambiar estado de " : "Change status on ") + orderLabel;
  }
  return { proposal: { token: sign(action), id: action.id, field: action.field, label, from, to } };
}

function delegate(incoming: NextRequest, pathname: string, method: "POST" | "PATCH", body: unknown) {
  return new NextRequest(new URL(pathname, incoming.nextUrl.origin), {
    method,
    headers: { Authorization: incoming.headers.get("authorization") || "", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function confirmAskAction(request: NextRequest, auth: Authorized, token: string): Promise<{ result: AskResponse; status: number }> {
  const action = verifyAskConfirmation(token, auth.principal);
  if (!action) return { result: { title: "Confirmation unavailable", summary: "Open the current suggestion again before confirming." }, status: 409 };
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
    const label = formatWorkOrder(row.display_id);
    return {
      result: {
        title: es ? "Orden de trabajo enviada" : "Work order submitted",
        summary: label + (row.status ? " · " + row.status : ""),
        savedOrder: { id: row.id, displayId: label },
        items: [{ id: "order:" + row.id, title: label, text: action.value, source: "CMPRI · Work orders", sourceType: "internal", record: { kind: "order", id: row.id, label } }],
        context: { language: action.language, sources: ["orders"], workOrders: [row.id] },
      },
      status: 200,
    };
  }
  if (action.field === "staff-note") {
    return { result: { title: es ? "Publicado en Notas del personal" : "Posted to Staff Notes", summary: action.value }, status: 200 };
  }
  const row = body.workOrder as AskOrder | undefined;
  return {
    result: {
      title: es ? "Orden actualizada" : "Work order updated",
      summary: row ? formatWorkOrder(row.display_id) + " · " + (action.field === "comment" ? es ? "Comentario guardado" : "Comment added" : String(row[action.field] || action.value))
        : es ? "Se guardó el cambio. Vuelve a abrir la orden para verla." : "The change was saved. Reopen the work order to see its current values.",
      ...(row ? { items: [askOrderItem(row, true)] } : {}),
      context: { language: action.language, sources: ["orders"], workOrders: [action.id] },
    },
    status: 200,
  };
}
