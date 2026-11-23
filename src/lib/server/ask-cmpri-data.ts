import "server-only";
import { NextRequest } from "next/server";
import { z } from "zod";
import type { AskContext, AskResultItem, AskSource } from "@/lib/ask-cmpri/types";
import { canReadChiefModuleData } from "@/lib/dashboard/chief-module-access";
import { canOpenRoomOperations } from "@/lib/dashboard/menu-access";
import { roomKey } from "@/lib/room-availability";
import { allows, type Principal } from "@/lib/server/access";
import type { AuthAttempt } from "@/lib/server/auth";
import { canReadEquipment } from "@/lib/server/roles";
import { loadCurrentRoomStatuses } from "@/lib/server/room-availability";
import { workOrderReader } from "@/lib/server/work-order-reader";
import { canReadWorkOrder } from "@/lib/work-order-read-policy";
import { formatWorkOrder, workOrderNumber, workOrderReferences } from "@/lib/work-order-reference.js";
import { workOrderSearchExpression } from "@/lib/work-order-search";
import { isUuid } from "@/lib/uuid";
import type { AskPlan } from "./ask-cmpri-gemini";

type Authorized = Extract<AuthAttempt, { ok: true }>;
type Data = Record<string, unknown>;
type SourceResult = { items: AskResultItem[]; missing?: string };
export type AskAsset = Data & { id: string; location_id: string | null; name: string; manufacturer: string | null; model_number: string | null };
export type AskOrder = Data & {
  id: string; display_id: string; hotel_id: string; room: string; issue: string;
  status: string; priority: string; revision: number; technician_name?: string | null;
};
export type AskLocation = Data & { id: string; name: string; room_number: string | null };

const sources: AskSource[] = ["orders", "assets", "rooms", "roomRank", "staffNotes", "personalNotes"];
const statusScope = ["all", "active", "in-progress", "completed", "closed"] as const;
export const askContextSchema = z.object({
  question: z.string().max(650).optional(),
  language: z.enum(["en", "es"]).optional(),
  sources: z.array(z.enum(sources)).max(6).optional(),
  rooms: z.array(z.string().max(20)).max(8).optional(),
  workOrders: z.array(z.string().max(45)).max(8).optional(),
  terms: z.array(z.string().max(80)).max(8).optional(),
  status: z.enum(statusScope).optional(),
  assignedOnly: z.boolean().optional(),
  format: z.enum(["brief", "bullets", "table"]).optional(),
  fields: z.array(z.string().max(48)).max(10).optional(),
  sortBy: z.string().max(48).optional(),
  sortDirection: z.enum(["asc", "desc", "none"]).optional(),
  roomIntent: z.enum(["roster", "availability", "late-checkouts", "features"]).optional(),
  pending: z.object({
    field: z.enum(["create", "status", "priority", "comment", "staff-note"]),
    needs: z.enum(["room", "issue", "staffName", "workOrder", "value", "photo"]),
    value: z.string().max(1000).optional(),
    priority: z.enum(["Low", "Medium", "High", "Urgent"]).optional(),
  }).optional(),
});

const statuses: Record<AskPlan["status"], string[]> = {
  all: [], active: ["Open", "In Progress", "Done", "Pending Verification"],
  "in-progress": ["In Progress"], completed: ["Completed"], closed: ["Closed", "Will Not Do"],
};
const maxItems = 30;
const orderProjection = "id,display_id,hotel_id,room,location_id,issue,notes,action_root_cause,priority,status,category,asset_id,asset_name,technician_name,last_assigned_technician_name,revision,created_by";
const locationProjection = "id,name,room_number,location_type,area";
const projectAsset = "id,location_id,name,asset_type,manufacturer,model_number,model_family,documentation_verified_at,active";

export function askText(value: unknown, max = 500) {
  return typeof value === "string" ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, max) : "";
}

/** Project only operational fields. Public web requests are assembled independently. */
function fact(label: string, value: unknown) {
  const text = askText(value, 320);
  return text ? [{ label, value: text }] : [];
}

export function canReadAskAssets(principal: Principal) {
  return allows(principal, "view_work_orders") && (canReadEquipment(principal.profile.role) || canReadChiefModuleData(principal));
}

export function askPermittedSources(principal: Principal): AskSource[] {
  return [
    ...(allows(principal, "view_work_orders") ? ["orders", "roomRank"] as const : []),
    ...(canReadAskAssets(principal) ? ["assets"] as const : []),
    ...(allows(principal, "submit") || allows(principal, "view_locations") || canOpenRoomOperations(principal.profile) ? ["rooms"] as const : []),
    "staffNotes", "personalNotes",
  ];
}

export function validAskRoom(value: string) {
  return /^(?:room\s*#?\s*)?[0-9]{1,4}[a-z]?$/i.test(value.trim()) ? roomKey(value) || "" : "";
}

export function askTerms(values: string[]) {
  return [...new Set(values.map((value) => askText(value, 64).replace(/[\r\n]{1,}/g, " ")).filter((value) => value.length > 1))].slice(0, 8);
}

export function applyAskContext(plan: AskPlan, question: string, previous?: AskContext): AskPlan {
  const references = workOrderReferences(question).map((ref) => ref.number);
  const mentions = [...question.matchAll(/\b(?:room\s*#?\s*)?(\d{2,3}[a-z]?)(?![\w-])\b/gi)]
    .filter((match) => !references.includes(match[1]))
    .map((match) => match[1]);
  const rooms = plan.rooms.length ? plan.rooms : references.length ? [] : mentions;
  const workOrders = references.length ? references : plan.workOrders;
  const formatting = /^(?:(?:please|can you|could you)\s+)*(?:put (?:that|it|this) (?:in|into)|table please|in a table|sort (?:it |them )?by|add (?:a |the )?(?:priority|room|status|source|work order)(?: column)?|keep it short|use bullet points|bullet points)\b/i.test(question.trim());
  const followUp = Boolean(previous && (plan.followUp || formatting || /\b(?:there|that room|same room|that ticket|same work order)\b/i.test(question)));
  const replacementFollowUp = followUp && plan.webIntent === "manufacturer" && !plan.model && previous?.sources?.includes("orders");
  const copyTarget = followUp && !rooms.length && !workOrders.length;
  const previousColumns = previous?.fields || [];
  const adding = followUp && /\b(?:add|include)\b/i.test(question) && previousColumns.length > 0;
  const defaultFormat = /\b(?:in a table|table please|sort (?:it |them )?by|add (?:a |the )?(?:priority|room|status|source|work order))\b/i.test(question)
    ? "table" : /\bbullet points\b/i.test(question) ? "bullets" : /\bkeep it short\b/i.test(question) ? "brief" : "default";
  const inferredSort = question.match(/\bsort (?:it |them )?by (priority|room|ticket status|repair state|checkout time|work order)\b/i)?.[1] || "";
  const assignedOnly = plan.assignedOnly || /\b(?:my assigned (?:tickets?|work|work orders?)|assign(?:ed)? to me|my tickets)\b/i.test(question)
    || Boolean((formatting || replacementFollowUp) && previous?.assignedOnly);
  const draft = previous?.pending;
  const continuesAction = draft && followUp;
  return {
    ...plan,
    followUp,
    sources: replacementFollowUp ? [...new Set<AskSource>(["orders", ...plan.sources])]
      : formatting && previous?.sources?.length ? previous.sources : plan.sources.length ? plan.sources : assignedOnly ? ["orders"] : followUp ? previous?.sources || [] : [],
    rooms: [...new Set((copyTarget ? previous?.rooms || [] : rooms).map(validAskRoom).filter(Boolean))].slice(0, 8),
    workOrders: [...new Set((copyTarget ? previous?.workOrders || [] : workOrders).map((value) => isUuid(value) ? value : workOrderNumber(value) || "").filter(Boolean))].slice(0, 8),
    terms: askTerms((formatting || replacementFollowUp) && previous?.terms?.length ? previous.terms
      : plan.terms.length ? plan.terms : followUp && plan.sources.every((item) => previous?.sources?.includes(item)) ? previous?.terms || [] : []),
    status: followUp && plan.status === "all" && (replacementFollowUp || plan.sources.every((item) => previous?.sources?.includes(item))) ? previous?.status || "all" : plan.status,
    assignedOnly,
    roomIntent: formatting && previous?.roomIntent ? previous.roomIntent : plan.roomIntent,
    format: plan.format !== "default" ? plan.format : defaultFormat !== "default" ? defaultFormat : followUp && previous?.format ? previous.format : "default",
    fields: adding ? [...new Set([...previousColumns, ...plan.fields, ...(/\badd (?:a |the )?priority\b/i.test(question) ? ["Priority"] : [])])].slice(0, 10) : plan.fields,
    sortBy: plan.sortBy || inferredSort || (formatting && previous?.sortBy ? previous.sortBy : ""),
    sortDirection: plan.sortDirection !== "none" ? plan.sortDirection : formatting && !inferredSort && previous?.sortDirection ? previous.sortDirection : "none",
    candidateAction: plan.candidateAction === "none" && continuesAction ? draft.field : plan.candidateAction,
    actionValue: plan.actionValue || (continuesAction ? draft.value || "" : ""),
    requestedPriority: plan.requestedPriority === "default" && continuesAction ? draft.priority || "default" : plan.requestedPriority,
  };
}

function titleRoom(room: string) {
  return /^room\b/i.test(room) ? room : /^\d{1,4}[a-z]?$/i.test(room) ? "Room " + room : room;
}

function repairOutcome(order: AskOrder) {
  if (order.status === "Completed") return "Repair complete · ticket awaiting closure";
  if (order.status === "In Progress") return "Repair in progress";
  if (order.status === "Will Not Do") return "Work declined";
  if (order.status === "Open" || order.status === "Pending Verification") return "Repair pending";
  const action = askText(order.action_root_cause, 700);
  if (order.status === "Closed" && /\b(?:replaced|repaired|repair complete|successfully restored)\b/i.test(action)
    && !/\b(?:not|never|unable|cannot|could not|pending)\b/i.test(action)) return "Repair complete per recorded action";
  return "Repair outcome unconfirmed";
}

export function askOrderItem(order: AskOrder, detailed = false, assignedAsset?: AskAsset): AskResultItem {
  const label = formatWorkOrder(order.display_id);
  const location = askText(order.room);
  const assetModel = assignedAsset && [askText(assignedAsset.manufacturer), askText(assignedAsset.model_number)].filter(Boolean).join(" ");
  return {
    id: "order:" + order.id,
    title: [location && titleRoom(location), label].filter(Boolean).join(" · "),
    text: askText(order.issue, 700),
    source: "CMPRI · Work orders",
    sourceType: "internal",
    record: { kind: "order", id: order.id, label },
    ...(assignedAsset ? { links: [{ kind: "asset", id: assignedAsset.id, label: askText(assignedAsset.name, 140) }] } : {}),
    facts: [
      ...fact("Room", location),
      ...fact("Ticket status", order.status),
      ...fact("Repair status", repairOutcome(order)),
      ...fact("Priority", order.priority),
      ...fact("Assigned to", order.technician_name),
      ...fact("Equipment", order.asset_name),
      ...fact("Installed model", assetModel),
      ...(detailed ? [...fact("Recorded action", order.action_root_cause), ...fact("Ticket notes", askText(order.notes, 650))] : []),
    ],
  };
}

function inRoom(order: AskOrder, rooms: string[]) {
  if (!rooms.length) return true;
  const room = roomKey(order.room);
  return !!room && rooms.includes(room);
}

function queryRoomPatterns(rooms: string[]) {
  return rooms.map(workOrderSearchExpression).filter(Boolean).join(",");
}

function queryOrderTerms(terms: string[]) {
  return terms.map(workOrderSearchExpression).filter(Boolean).join(",");
}

export async function askOrders(auth: Authorized, plan: Pick<AskPlan, "rooms" | "workOrders" | "terms" | "status" | "assignedOnly">): Promise<AskOrder[]> {
  const reader = workOrderReader(auth.principal);
  if (!reader.canRead || plan.assignedOnly && !reader.technicianName) return [];
  const query = () => {
    const request = auth.admin.from("work_orders").select(orderProjection).eq("hotel_id", auth.principal.hotelId);
    return plan.assignedOnly ? request.eq("technician_name", reader.technicianName) : request;
  };
  const values: AskOrder[][] = [];
  if (plan.workOrders.length) {
    const ids = plan.workOrders.filter(isUuid);
    const numbers = plan.workOrders.filter((value) => !isUuid(value));
    const results = await Promise.all([
      ids.length ? query().in("id", ids) : null,
      numbers.length ? query().or(queryOrderTerms(numbers.map((value) => "WO#" + value))).limit(100) : null,
    ]);
    for (const result of results) {
      if (result?.error) throw new Error("Orders unavailable");
      if (result?.data) values.push((result.data as AskOrder[]).filter((row) =>
        ids.includes(row.id) || numbers.includes(workOrderNumber(row.display_id) || "")));
    }
  } else {
    const roomExpression = queryRoomPatterns(plan.rooms);
    const termExpression = queryOrderTerms(plan.terms);
    let request = query();
    if (roomExpression) request = request.or(roomExpression);
    if (termExpression) request = request.or(termExpression);
    if (statuses[plan.status].length) request = request.in("status", statuses[plan.status]);
    const result = await request.order("created_at", { ascending: false }).limit(maxItems + 10);
    if (result.error) throw new Error("Orders unavailable");
    values.push(result.data as AskOrder[] || []);
  }
  return [...new Map(values.flat().filter((row) => canReadWorkOrder(reader, row) && inRoom(row, plan.rooms)).map((row) => [row.id, row])).values()].slice(0, maxItems);
}

export async function askLocations(auth: Authorized, roomNumbers: string[], terms: string[] = []): Promise<AskLocation[]> {
  const { principal } = auth;
  if (!allows(principal, "submit") && !allows(principal, "view_locations") && !canOpenRoomOperations(principal.profile)) return [];
  let query = auth.admin.from("locations").select(locationProjection).eq("hotel_id", principal.hotelId).eq("active", true);
  if (roomNumbers.length) query = query.in("room_number", [...roomNumbers, ...roomNumbers.map((value) => value.toUpperCase())]);
  else if (terms.length) query = query.or(terms.flatMap((term) => ["name", "area", "location_type"].map((field) => field + ".ilike." + literalPattern(term))).join(","));
  const result = await query.order("room_number", { ascending: true }).limit(roomNumbers.length ? 30 : 600);
  if (result.error) throw new Error("Rooms unavailable");
  return result.data as AskLocation[] || [];
}

function literalPattern(value: string) {
  return JSON.stringify("%" + value.replace(/[%_\\]/g, "\\$&") + "%");
}

export async function askAssets(auth: Authorized, selection: { rooms: AskLocation[]; terms: string[]; ids?: string[]; make?: string; model?: string; targetedRooms?: boolean }): Promise<AskAsset[]> {
  if (!canReadAskAssets(auth.principal)) return [];
  if (selection.targetedRooms && !selection.rooms.length && !selection.ids?.length) return [];
  let query = auth.admin.from("assets").select(projectAsset).eq("hotel_id", auth.principal.hotelId).eq("active", true);
  if (selection.ids?.length) query = query.in("id", selection.ids.filter(isUuid));
  else {
    if (selection.rooms.length) query = query.in("location_id", selection.rooms.map(({ id }) => id));
    const values = [selection.model || "", ...selection.terms].filter(Boolean);
    if (values.length) query = query.or(values.flatMap((term) =>
      ["name", "asset_type", "manufacturer", "model_family", "model_number"].map((field) => field + ".ilike." + literalPattern(term))).join(","));
    else if (selection.make) query = query.ilike("manufacturer", "%" + selection.make.replace(/[%_\\]/g, "\\$&") + "%");
  }
  const result = await query.order("name", { ascending: true }).limit(maxItems);
  if (result.error) throw new Error("Assets unavailable");
  return result.data as AskAsset[] || [];
}

function assetItem(asset: AskAsset, locations: AskLocation[]): AskResultItem {
  const name = [askText(asset.manufacturer), askText(asset.model_number)].filter(Boolean).join(" ");
  return {
    id: "asset:" + asset.id, title: name || asset.name, text: askText(asset.name, 180), source: "CMPRI · Assets", sourceType: "internal",
    record: { kind: "asset", id: asset.id, label: "Open equipment" },
    facts: [
      ...fact("Equipment", asset.name),
      ...fact("Location", locations.find(({ id }) => id === asset.location_id)?.name),
      ...fact("Manufacturer", asset.manufacturer), ...fact("Model", asset.model_number),
      ...fact("Documentation", asset.documentation_verified_at ? "Verified equipment documentation" : ""),
    ],
  };
}

function dateTime(value: string) {
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  return Number.isFinite(hour) && Number.isFinite(minute) ? (hour % 12 || 12) + ":" + String(minute).padStart(2, "0") + (hour < 12 ? " AM" : " PM") : "";
}

async function roomSource(auth: Authorized, plan: AskPlan, locations: AskLocation[], orders: AskOrder[]): Promise<SourceResult> {
  const fullOperations = canOpenRoomOperations(auth.principal.profile);
  const list = plan.rooms.length ? locations.filter(({ room_number }) => room_number && plan.rooms.includes(roomKey(room_number))) : locations;
  const roomStatuses = plan.roomIntent === "availability" || plan.roomIntent === "late-checkouts" ? await loadCurrentRoomStatuses(auth.admin) : null;
  if (roomStatuses?.error) throw new Error("Room availability unavailable");
  let available = list;
  if (plan.roomIntent === "late-checkouts") {
    const accessibleRooms = new Set(orders.map((row) => roomKey(row.room)));
    available = available.filter((item) => {
      const id = roomKey(item.room_number);
      const operation = roomStatuses?.operations?.get(id);
      return (fullOperations || accessibleRooms.has(id)) && operation?.checkout_date === roomStatuses?.date && (operation?.checkout_time || "") > "11:00:00";
    });
  }
  const items: AskResultItem[] = available.slice(0, maxItems).map((item) => {
    const id = roomKey(item.room_number || item.name);
    const operation = roomStatuses?.operations?.get(id);
    const state = roomStatuses?.statuses?.get(id);
    const roomTitle = titleRoom(item.room_number || item.name);
    return {
      id: "room:" + item.id, title: roomTitle,
      ...(plan.roomIntent === "availability" && state ? { text: state } : {}),
      source: roomStatuses ? fullOperations ? "CMPRI · Room Operations" : plan.roomIntent === "late-checkouts" ? "CMPRI · Work-order room details" : "CMPRI · Rooms" : "CMPRI · Rooms",
      sourceType: "internal",
      facts: [
        ...fact("Room", item.room_number),
        ...fact("Location type", item.location_type),
        ...fact("Area", item.area),
        ...fact("Room availability", state),
        ...(plan.roomIntent === "late-checkouts" && operation?.checkout_time ? fact("Checkout time", dateTime(operation.checkout_time)) : []),
      ],
    };
  });
  return { items, missing: plan.roomIntent === "features" ? "The room register has no amenity or designated-model field. Report user-requested features only if a matching authorized equipment record was supplied. Absence does not establish that a feature is missing." : undefined };
}

function nativeGet(request: NextRequest, pathname: string) {
  const bearer = request.headers.get("authorization") || "";
  return new NextRequest(new URL(pathname, request.nextUrl.origin), { method: "GET", headers: { Authorization: bearer } });
}

async function rankingSource(request: NextRequest, plan: AskPlan): Promise<SourceResult> {
  const { GET } = await import("@/app/api/ticket-room-ranker/route");
  const response = await GET(nativeGet(request, "/api/ticket-room-ranker"));
  if (!response.ok) throw new Error("Room Ranker unavailable");
  const data = await response.json();
  const values: Array<{ id: string; number: string; rank: string; issues?: unknown[] }> = data.rooms || [];
  return {
    items: values.filter((room) => !plan.rooms.length || plan.rooms.includes(roomKey(room.number))).slice(0, maxItems).map((room) => ({
      id: "rank:" + room.id, title: titleRoom(room.number), source: "CMPRI · Room Ranker", sourceType: "internal",
      record: { kind: "roomRank", id: room.id, label: "Open Room Ranker" },
      facts: [...fact("Room rank", room.rank), ...fact("Open issues", String(room.issues?.length || 0))],
    })),
  };
}

async function notesSource(auth: Authorized, plan: AskPlan, personal: boolean): Promise<SourceResult> {
  const { principal } = auth;
  if (!personal) {
    let query = auth.admin.from("cmpri_staff_notes").select("id,author_name,body,created_at").eq("hotel_id", principal.hotelId);
    if (plan.terms.length) query = query.or(plan.terms.map((term) => "body.ilike." + literalPattern(term)).join(","));
    const result = await query.order("created_at", { ascending: false }).limit(18);
    if (result.error) throw new Error("Staff Notes unavailable");
    return { items: (result.data || []).map((item) => ({
      id: "staff:" + item.id, title: askText(item.author_name, 100) || "Staff Notes",
      text: askText(item.body, 750), source: "CMPRI · Staff Notes", sourceType: "internal",
      record: { kind: "staffNote", id: item.id, label: "Open Staff Notes" },
    })) };
  }
  let query = auth.admin.from("cmpri_general_notes").select("id,title,text:document->>text,updated_at")
    .eq("hotel_id", principal.hotelId).eq("user_id", principal.identity.id).is("deleted_at", null);
  if (plan.terms.length) query = query.or(plan.terms.flatMap((term) =>
    ["title", "document->>text"].map((field) => field + ".ilike." + literalPattern(term))).join(","));
  const result = await query.order("updated_at", { ascending: false }).limit(18);
  if (result.error) throw new Error("Personal Notepad unavailable");
  return { items: (result.data || []).map((item) => ({
    id: "note:" + item.id, title: askText(item.title, 130) || "Personal note",
    text: askText(item.text, 750), source: "CMPRI · Personal Notepad", sourceType: "internal",
    record: { kind: "personalNote", id: item.id, label: "Open note" },
  })) };
}

export async function readAskSources(request: NextRequest, auth: Authorized, plan: AskPlan) {
  const permitted = askPermittedSources(auth.principal);
  const requested = plan.sources.filter((name) => permitted.includes(name));
  const missing = plan.sources.filter((name) => !permitted.includes(name)).map((name) => name + " is outside this account’s access.");
  const settle = async <T>(promise: Promise<T>, name: string, empty: T) => {
    try { return await promise; }
    catch { missing.push(name + " is unavailable."); return empty; }
  };
  const [locations, orders] = await Promise.all([
    requested.some((name) => name === "rooms" || name === "assets") || plan.candidateAction === "create"
      ? settle(askLocations(auth, plan.rooms), "CMPRI room records", []) : [],
    requested.includes("orders") || plan.roomIntent === "late-checkouts" || ["status", "priority", "comment"].includes(plan.candidateAction)
      ? settle(askOrders(auth, { ...plan, ...(plan.roomIntent === "late-checkouts" ? { terms: [], status: "all" as const } : {}) }), "CMPRI work orders", []) : [],
  ]);
  const assetSelection = requested.includes("assets") || requested.includes("orders") && canReadAskAssets(auth.principal) && orders.some((row) => row.asset_id);
  const assetIds = orders.map((order) => askText(order.asset_id, 50)).filter(isUuid);
  const assets = assetSelection
    ? await settle(askAssets(auth, requested.includes("assets")
      ? { rooms: plan.rooms.length ? locations : [], terms: plan.terms, make: plan.manufacturer, model: plan.model, targetedRooms: plan.rooms.length > 0 }
      : { rooms: [], terms: [], ids: assetIds }), "CMPRI equipment", []) : [];
  const linkedAssets = new Map(assets.map((item) => [item.id, item]));
  const independent = await Promise.all(requested.flatMap((name) => {
    if (name === "rooms") return [settle(roomSource(auth, plan, locations, orders), "CMPRI room status", { items: [] })];
    if (name === "roomRank") return [settle(rankingSource(request, plan), "CMPRI Room Ranker", { items: [] })];
    if (name === "staffNotes" || name === "personalNotes") return [settle(notesSource(auth, plan, name === "personalNotes"), name === "personalNotes" ? "Personal Notepad" : "Staff Notes", { items: [] })];
    return [];
  }));
  const items = [
    ...(requested.includes("orders") ? orders.map((order) => {
      const asset = linkedAssets.get(String(order.asset_id));
      return askOrderItem(order, orders.length <= 2, order.location_id && asset?.location_id === order.location_id ? asset : undefined);
    }) : []),
    ...(requested.includes("assets") ? assets.map((asset) => assetItem(asset, locations)) : []),
    ...independent.flatMap(({ items }) => items),
  ].slice(0, 65);
  missing.push(...independent.map((part) => part.missing).filter((entry): entry is string => Boolean(entry)));
  return { orders, locations, assets, items, missing };
}
