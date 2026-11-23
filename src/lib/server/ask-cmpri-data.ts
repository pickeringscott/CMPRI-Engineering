import "server-only";
import { NextRequest } from "next/server";
import { z } from "zod";
import type { AskContext, AskResultItem, AskSource } from "@/lib/ask-cmpri/types";
import { canReadChiefModuleData } from "@/lib/dashboard/chief-module-access";
import { canOpenRoomOperations } from "@/lib/dashboard/menu-access";
import { roomKey, roomStatusBadge } from "@/lib/room-availability";
import { allows, type Principal } from "@/lib/server/access";
import type { AuthAttempt } from "@/lib/server/auth";
import { canReadEquipment } from "@/lib/server/roles";
import { loadCurrentRoomStatuses } from "@/lib/server/room-availability";
import { workOrderReader } from "@/lib/server/work-order-reader";
import { canReadWorkOrder } from "@/lib/work-order-read-policy";
import { formatWorkOrder, workOrderNumber, workOrderReferences } from "@/lib/work-order-reference.js";
import { workOrderSearchExpression } from "@/lib/work-order-search";
import { isUuid } from "@/lib/uuid";
import { listRegisteredAssetFiles } from "@/lib/server/asset-file-register";
import type { AskPlan } from "./ask-cmpri-gemini";

type Authorized = Extract<AuthAttempt, { ok: true }>;
type Data = Record<string, unknown>;
type SourceResult = { items: AskResultItem[]; missing?: string };
export type AskAsset = Data & {
  id: string; location_id: string | null; name: string; manufacturer: string | null; model_number: string | null;
  documentation_verified?: boolean;
};
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
  locationNames: z.array(z.string().max(100)).max(8).optional(),
  ticketStatus: z.string().max(30).optional(),
  checkoutAfter: z.string().max(20).optional(),
  roomAvailability: z.string().max(48).optional(),
  assetState: z.enum(["active", "retired", "all"]).optional(),
  rank: z.enum(["A", "B", "C"]).optional(),
  fromDate: z.string().max(10).optional(),
  toDate: z.string().max(10).optional(),
  noteAuthor: z.string().max(80).optional(),
  publicEquipment: z.object({ manufacturer: z.string().max(80), model: z.string().max(80), errorCode: z.string().max(24).optional() }).optional(),
  webIntent: z.enum(["none", "manual", "manufacturer", "error-code", "public-guidance"]).optional(),
  focus: z.enum(["error-code", "equipment"]).optional(),
  evidence: z.array(z.string().max(125)).max(75).optional(),
  contextProof: z.string().max(90).optional(),
  pending: z.object({
    field: z.enum(["create", "status", "priority", "comment", "staff-note"]),
    needs: z.enum(["room", "issue", "staffName", "workOrder", "value", "photo"]),
    value: z.string().max(1000).optional(),
    priority: z.enum(["Low", "Medium", "High", "Urgent"]).optional(),
    staffName: z.string().max(80).optional(),
    photoRequired: z.boolean().optional(),
  }).optional(),
});

const statuses: Record<AskPlan["status"], string[]> = {
  all: [], active: ["Open", "In Progress"],
  "in-progress": ["In Progress"], completed: ["Completed", "Done"], closed: ["Closed"],
};
const exactStatuses = ["Pending Verification", "Open", "In Progress", "Completed", "Done", "Closed", "Will Not Do"];
const maxItems = 30;
const orderProjection = "id,display_id,hotel_id,room,location_id,issue,notes,action_root_cause,priority,ranker_base_priority,status,category,asset_id,asset_name,technician_name,last_assigned_technician_name,revision,created_by,created_at,updated_at,due_by";
const locationProjection = "id,name,room_number,location_type,area";
const projectAsset = "id,location_id,name,asset_type,manufacturer,model_number,model_family,documentation_verified_at,documentation_revision_id,active";

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
  return value.trim().match(/^(?:(?:room|rm|habitaci[oó]n|cuarto)\s*#?\s*)?(\d{1,4}[a-z]?)$/i)?.[1].toUpperCase() || "";
}

export function explicitAskOrders(question: string) {
  const direct = [...question.matchAll(/\b(?:ticket|orden(?: de trabajo)?)\s*#?\s*(\d{1,14})(?![\w-])/giu)].map((match) => match[1]);
  const workOrders = workOrderReferences(question).filter((ref) => {
    const prefix = question.slice(Math.max(0, ref.start - 24), ref.start);
    return !/(?:\brm|habitaci[oó]n|\bcuarto|error code|c[oó]digo)\s*$/i.test(prefix);
  });
  return [...new Set([...workOrders.map((ref) => ref.number), ...direct])];
}

export function asksToReformat(question: string) {
  return /^(?:(?:please|can you|could you|por favor)\s+)*(?:put (?:that|it|this) (?:in|into)|table please|in a table|sort (?:it |them )?by|add (?:a |the )?(?:priority|room|status|source|work order|date|due date|technician)(?: column)?|keep it short|use bullet points|bullet points|download (?:that|it|this)|export (?:that|it|this)|pon(?:lo|la)? (?:en|como) (?:una )?tabla|ordena(?:lo|la)? por|a[ñn]ade (?:la )?columna|en vi[ñn]etas)\b/i.test(question.trim());
}

export function askTerms(values: string[]) {
  return [...new Set(values.map((value) => askText(value, 64).replace(/[\r\n]{1,}/g, " ")).filter((value) => value.length > 1))].slice(0, 8);
}

function equipmentTerms(question: string) {
  const equipment = [
    [/\b(?:microwaves?|microondas)\b/i, ["microwave", "microondas"]],
    [/\b(?:toilets?|inodoros?)\b/i, ["toilet", "inodoro"]],
    [/\b(?:washers?|lavadoras?)\b/i, ["washer", "lavadora"]],
    [/\b(?:air conditioning|air conditioners?|a\/c|ac|aire acondicionado|no enfr[ií]a)\b/i, ["AC", "HVAC", "aire acondicionado"]],
    [/\b(?:showers?|duchas?)\b/i, ["shower", "ducha"]],
    [/\b(?:spare filters?|filtros? de repuesto)\b/i, ["filter", "filtro"]],
    [/\b(?:salt|sal|deicer)\b/i, ["salt", "sal"]],
  ] as const;
  return equipment.flatMap(([pattern, terms]) => pattern.test(question) ? [...terms] : []);
}

export function applyAskContext(plan: AskPlan, question: string, previous?: AskContext): AskPlan {
  const references = explicitAskOrders(plan.candidateAction === "comment" ? question.split(/[:“"]/u, 1)[0] : question);
  const statedRooms = [...question.matchAll(/(?:\broom|\brm|\bcuarto|habitaci[oó]n)\s*#?\s*(\d{1,4}[a-z]?)(?![\w:-])/gi)].map((match) => match[1]);
  const leadingRoom = question.trim().match(/^(\d{2,4}[a-z]?)(?:\s*[?:,.!]|\s+(?:ac|a\/c|no |won't|heat|has |needs |sofa|toilet|microwave|sink)\b|$)/i)?.[1];
  const mentions = statedRooms.length ? statedRooms : leadingRoom ? [leadingRoom] : [];
  const ignoreNumericGuess = plan.roomIntent === "late-checkouts" && !mentions.length;
  const rooms = mentions.length ? mentions : ignoreNumericGuess ? [] : plan.rooms;
  const workOrders = references.length ? references : plan.workOrders;
  const formatting = asksToReformat(question);
  const followUp = Boolean(previous && (plan.followUp || formatting || /\b(?:there|that room|same room|that ticket|same work order|all[ií]|esa habitaci[oó]n|esa orden)\b/i.test(question)));
  const replacementFollowUp = followUp && plan.webIntent === "manufacturer" && !plan.model && previous?.sources?.includes("orders");
  const copyTarget = followUp && !rooms.length && !workOrders.length;
  const previousColumns = previous?.fields || [];
  const adding = followUp && /\b(?:add|include)\b/i.test(question) && previousColumns.length > 0;
  const defaultFormat = /\b(?:in a table|as a table|table please|sort (?:it |them )?by|add (?:a |the )?(?:priority|room|status|source|work order|date|due date|technician)|en (?:una )?tabla)\b/i.test(question)
    ? "table" : /\b(?:bullet points|vi[ñn]etas)\b/i.test(question) ? "bullets" : /\b(?:keep it short|short answer|respuesta breve)\b/i.test(question) ? "brief" : "default";
  const inferredSort = question.match(/\bsort (?:it |them )?by (priority|room|ticket status|repair status|repair state|checkout time|work order|date|due date|created|updated)\b/i)?.[1] || "";
  const mentionsAll = /\b(?:all (?:tickets|work orders)|all technicians|todos los (?:tickets|t[eé]cnicos))\b/i.test(question);
  const assignedOnly = !mentionsAll && (plan.assignedOnly || /\b(?:my assigned (?:tickets?|work|work orders?)|assign(?:ed)? to me|my tickets|mis (?:tickets|[oó]rdenes))\b/i.test(question)
    || Boolean(followUp && previous?.assignedOnly));
  const inheritFilters = followUp && (formatting || replacementFollowUp || !plan.sources.length || plan.sources.every((item) => previous?.sources?.includes(item)));
  const rank = question.match(/\b(?:rank(?:ed|ing)?|grado)\s*([abc])\b/i)?.[1]?.toUpperCase() as AskPlan["rank"];
  const after = question.match(/\b(?:after|past|despu[eé]s de(?: las)?)\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\b/i)?.[1];
  const additionalField = question.match(/\badd (?:a |the )?(priority|room|status|source|work order|date|due date|technician)\b/i)?.[1];
  const translatedTerms = equipmentTerms(question);
  return {
    ...plan,
    followUp,
    sources: replacementFollowUp ? [...new Set<AskSource>(["orders", "assets", ...plan.sources])]
      : formatting && previous?.sources?.length ? previous.sources : plan.sources.length ? plan.sources : assignedOnly ? ["orders"] : followUp ? previous?.sources || [] : [],
    rooms: [...new Set((copyTarget ? previous?.rooms || [] : rooms).map(validAskRoom).filter(Boolean))].slice(0, 8),
    workOrders: [...new Set((copyTarget ? previous?.workOrders || [] : workOrders).map((value) => isUuid(value) ? value : workOrderNumber(value) || "").filter(Boolean))].slice(0, 8),
    terms: askTerms((formatting || replacementFollowUp) && previous?.terms?.length ? previous.terms
      : translatedTerms.length ? [...translatedTerms, ...plan.terms.filter((term) => !/^(?:broken|issues?|problem|out|repair|maintenance)$/i.test(term))]
        : plan.terms.length ? plan.terms : inheritFilters ? previous?.terms || [] : []),
    status: inheritFilters && !mentionsAll && plan.status === "all" ? previous?.status || "all" : plan.status,
    assignedOnly,
    roomIntent: formatting && previous?.roomIntent ? previous.roomIntent : plan.roomIntent,
    format: plan.format !== "default" ? plan.format : defaultFormat !== "default" ? defaultFormat : followUp && previous?.format ? previous.format : "default",
    fields: adding ? [...new Set([...previousColumns, ...plan.fields, ...(additionalField ? [additionalField[0].toUpperCase() + additionalField.slice(1)] : [])])].slice(0, 10) : plan.fields,
    sortBy: plan.sortBy || inferredSort || (formatting && previous?.sortBy ? previous.sortBy : ""),
    sortDirection: plan.sortDirection !== "none" ? plan.sortDirection : formatting && !inferredSort && previous?.sortDirection ? previous.sortDirection : "none",
    locationNames: plan.locationNames?.length ? plan.locationNames : copyTarget ? previous?.locationNames : undefined,
    rank: rank || plan.rank || (inheritFilters ? previous?.rank : undefined),
    checkoutAfter: after || plan.checkoutAfter || (inheritFilters ? previous?.checkoutAfter : undefined),
    roomAvailability: plan.roomAvailability || (inheritFilters ? previous?.roomAvailability : undefined),
    assetState: plan.assetState || (inheritFilters ? previous?.assetState : undefined),
    fromDate: plan.fromDate || (inheritFilters ? previous?.fromDate : undefined),
    toDate: plan.toDate || (inheritFilters ? previous?.toDate : undefined),
    ticketStatus: plan.ticketStatus || (inheritFilters && plan.status === "all" && !mentionsAll ? previous?.ticketStatus : undefined),
    noteAuthor: plan.noteAuthor || (inheritFilters ? previous?.noteAuthor : undefined),
  };
}

function titleRoom(room: string) {
  return /^room\b/i.test(room) ? room : /^\d{1,4}[a-z]?$/i.test(room) ? "Room " + room : room;
}

function repairOutcome(order: AskOrder) {
  if (order.status === "Completed" || order.status === "Done") return "Repair complete · ticket awaiting closure";
  if (order.status === "In Progress") return "Repair in progress";
  if (order.status === "Will Not Do") return "Work declined";
  if (order.status === "Open" || order.status === "Pending Verification") return "Repair pending";
  const action = askText(order.action_root_cause, 700);
  if (order.status === "Closed" && /\b(?:replaced|repaired|repair complete|successfully restored|resolved|reparad[oa]|reemplazad[oa]|resuelt[oa])\b/i.test(action)
    && !/\b(?:not|never|unable|cannot|could not|pending|still|todav[ií]a|pendiente|no)\b/i.test(action)) return "Repair complete per recorded action";
  return "Repair outcome unconfirmed";
}

export function askOrderItem(order: AskOrder, detailed = false, assignedAsset?: AskAsset, terms: string[] = []): AskResultItem {
  const label = formatWorkOrder(order.display_id);
  const location = askText(order.room);
  const assetModel = assignedAsset?.active === true && order.location_id && assignedAsset.location_id === order.location_id
    ? [askText(assignedAsset.manufacturer), askText(assignedAsset.model_number)].filter(Boolean).join(" ") : "";
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
      ...fact("Created", order.created_at), ...fact("Updated", order.updated_at), ...fact("Due date", order.due_by),
      ...(order.ranker_base_priority && order.ranker_base_priority !== order.priority ? fact("Base priority", order.ranker_base_priority) : []),
      ...(detailed ? [...fact("Recorded action", relevantExcerpt(order.action_root_cause, terms, 320)), ...fact("Ticket notes", relevantExcerpt(order.notes, terms, 320))] : []),
    ],
  };
}

function inRoom(order: AskOrder, rooms: string[]) {
  if (!rooms.length) return true;
  const room = validAskRoom(order.room);
  return !!room && rooms.includes(room);
}

function queryRoomPatterns(rooms: string[]) {
  return rooms.flatMap((room) => [room, `Room ${room}`, `Room #${room}`, `Room#${room}`, `Room${room}`])
    .map((room) => "room.ilike." + literalPattern(room, false)).join(",");
}

function queryOrderTerms(terms: string[]) {
  return terms.map(workOrderSearchExpression).filter(Boolean).join(",");
}

type OrderSelection = Pick<AskPlan, "rooms" | "workOrders" | "terms" | "status" | "assignedOnly" | "ticketStatus" | "fromDate" | "toDate">;

function orderStatuses(plan: OrderSelection) {
  const exact = exactStatuses.find((value) => value.toLowerCase() === plan.ticketStatus?.toLowerCase());
  return exact ? [exact] : statuses[plan.status];
}

function dateBound(value?: string) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(value + "T06:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
}

function dateEdge(date: string) {
  const midnight = new Date(date + "T06:00:00Z");
  const hours = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "America/Chicago" }).format(midnight);
  midnight.setUTCHours(6 - Number(hours));
  return midnight.toISOString();
}

function nextDay(value: string) {
  const date = new Date(value + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export async function askOrders(auth: Authorized, plan: OrderSelection): Promise<AskOrder[]> {
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
    const exact = numbers.flatMap((number) => [number, `WO#${number}`, `WO# ${number}`, `WO-${number}`, `WO${number}`, `WO ${number}`, `workorder_${number}`, `Work order ${number}`, `Work order #${number}`, `#${number}`, `@${number}`]);
    const results = await Promise.all([
      ids.length ? query().in("id", ids) : null,
      exact.length ? query().or(exact.map((number) => "display_id.ilike." + literalPattern(number, false)).join(",")).limit(100) : null,
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
    const interval = orderStatuses(plan);
    if (interval.length) request = request.in("status", interval);
    const from = dateBound(plan.fromDate), to = dateBound(plan.toDate);
    if (from) request = request.gte("created_at", dateEdge(from));
    if (to) request = request.lt("created_at", dateEdge(nextDay(to)));
    const result = await request.order("created_at", { ascending: false }).limit(maxItems + 10);
    if (result.error) throw new Error("Orders unavailable");
    values.push(result.data as AskOrder[] || []);
  }
  const interval = plan.workOrders.length > 1 ? orderStatuses(plan) : [];
  return [...new Map(values.flat().filter((row) => canReadWorkOrder(reader, row) && inRoom(row, plan.rooms) && (!interval.length || interval.includes(row.status))).map((row) => [row.id, row])).values()].slice(0, maxItems);
}

export async function askLocations(auth: Authorized, roomNumbers: string[], names: string[] = [], ids: string[] = []): Promise<AskLocation[]> {
  const { principal } = auth;
  if (!allows(principal, "submit") && !allows(principal, "view_locations") && !canOpenRoomOperations(principal.profile)) return [];
  let query = auth.admin.from("locations").select(locationProjection).eq("hotel_id", principal.hotelId).eq("active", true);
  if (ids.length) query = query.in("id", ids);
  else if (roomNumbers.length) query = query.in("room_number", [...new Set([...roomNumbers, ...roomNumbers.map((value) => value.toLowerCase())])]);
  else if (names.length) query = query.or(names.map((name) => "name.ilike." + literalPattern(name, false)).join(","));
  const result = await query.order("room_number", { ascending: true }).limit(roomNumbers.length ? 30 : 600);
  if (result.error) throw new Error("Rooms unavailable");
  return result.data as AskLocation[] || [];
}

function literalPattern(value: string, wildcard = true) {
  const expression = value.replace(/[%_\\]/g, "\\$&");
  return JSON.stringify(wildcard ? `%${expression}%` : expression);
}

function relevantExcerpt(value: unknown, terms: string[], maximum: number) {
  const whole = askText(value, 200_000);
  if (whole.length <= maximum) return whole;
  const lower = whole.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term.toLowerCase())).filter((at) => at >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - Math.floor(maximum / 3)) : 0;
  const end = start + maximum - 2;
  return (start ? "…" : "") + whole.slice(start, end).trim() + (end < whole.length ? "…" : "");
}

export async function askAssets(auth: Authorized, selection: { rooms: AskLocation[]; terms: string[]; ids?: string[]; make?: string; model?: string; targetedRooms?: boolean; state?: AskPlan["assetState"] }): Promise<AskAsset[]> {
  if (!canReadAskAssets(auth.principal)) return [];
  if (selection.targetedRooms && !selection.rooms.length && !selection.ids?.length) return [];
  let query = auth.admin.from("assets").select(projectAsset).eq("hotel_id", auth.principal.hotelId);
  if (!selection.ids?.length && selection.state !== "all") query = query.eq("active", selection.state !== "retired");
  if (selection.ids?.length) query = query.in("id", selection.ids.filter(isUuid));
  else {
    if (selection.rooms.length) query = query.in("location_id", selection.rooms.map(({ id }) => id));
    const values = selection.model ? [selection.model] : selection.terms;
    if (values.length) query = query.or(values.flatMap((term) =>
      ["name", "asset_type", "manufacturer", "model_family", "model_number"].map((field) => field + ".ilike." + literalPattern(term))).join(","));
    if (selection.make) query = query.ilike("manufacturer", "%" + selection.make.replace(/\s+(?:appliances|electronics)$/i, "").replace(/[%_\\]/g, "\\$&") + "%");
  }
  const result = await query.order("name", { ascending: true }).limit(maxItems);
  if (result.error) throw new Error("Assets unavailable");
  return result.data as AskAsset[] || [];
}

async function verifyAskAsset(auth: Authorized, asset: AskAsset, listManuals: boolean): Promise<AskAsset> {
  if (asset.documentation_revision_id) return { ...asset, documentation_verified: false };
  if (asset.documentation_verified_at && !listManuals) return { ...asset, documentation_verified: true };
  const { data, error } = await listRegisteredAssetFiles(auth.admin, asset.id);
  const verified = Boolean(asset.documentation_verified_at) || !error && data.some(({ name }) => name === "_cmpri-verification.json");
  const manuals = listManuals && verified && !error ? data.filter(({ name }) => /\.pdf$/i.test(name)).slice(0, 12).map(({ name }) => name) : [];
  return { ...asset, documentation_verified: verified, manuals };
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
      ...fact("Asset status", asset.active === false ? "Retired" : "Active"),
      ...fact("Documentation", asset.documentation_verified ? "Verified equipment documentation" : ""),
      ...fact("CMPRI manual files", Array.isArray(asset.manuals) ? asset.manuals.join(", ") : ""),
    ],
  };
}

function dateTime(value: string) {
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  return Number.isFinite(hour) && Number.isFinite(minute) ? (hour % 12 || 12) + ":" + String(minute).padStart(2, "0") + (hour < 12 ? " AM" : " PM") : "";
}

function checkoutMinutes(value: string) {
  const parsed = value.trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])?\.?m?\.?$/i);
  if (!parsed) return null;
  const hour = Number(parsed[1]), minute = Number(parsed[2] || 0), meridiem = parsed[3]?.toLowerCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23) || meridiem && hour < 1) return null;
  return (meridiem ? hour % 12 + (meridiem === "p" ? 12 : 0) : hour) * 60 + minute;
}

async function authorizedCheckoutRooms(auth: Authorized, candidates: AskLocation[]) {
  const reader = workOrderReader(auth.principal), checked = new Set<string>();
  if (!reader.canRead) return checked;
  for (let start = 0; start < candidates.length; start += 20) {
    const page = candidates.slice(start, start + 20);
    const ids = new Map(page.map(({ id, room_number }) => [id, validAskRoom(room_number || "")]));
    const numbers = [...ids.values()].filter(Boolean);
    const expression = `location_id.in.(${[...ids.keys()].map((id) => JSON.stringify(id)).join(",")}),${queryRoomPatterns(numbers)}`;
    const found = new Set<string>();
    for (let from = 0; found.size < ids.size; from += 150) {
      const result = await auth.admin.from("work_orders").select("id, hotel_id, location_id, room").eq("hotel_id", auth.principal.hotelId)
        .or(expression).order("id", { ascending: true }).range(from, from + 149);
      if (result.error) throw new Error("Checkout access unavailable");
      for (const row of result.data || []) {
        if (!canReadWorkOrder(reader, row)) continue;
        const number = row.location_id ? ids.get(row.location_id) : validAskRoom(row.room || "");
        if (number && numbers.includes(number)) found.add(number);
      }
      if (!result.data || result.data.length < 150) break;
    }
    for (const number of found) checked.add(number);
  }
  return checked;
}

async function roomSource(auth: Authorized, plan: AskPlan, locations: AskLocation[]): Promise<SourceResult> {
  const fullOperations = canOpenRoomOperations(auth.principal.profile);
  const list = plan.rooms.length ? locations.filter(({ room_number }) => room_number && plan.rooms.includes(validAskRoom(room_number))) : locations;
  const roomStatuses = plan.roomIntent === "availability" || plan.roomIntent === "late-checkouts" ? await loadCurrentRoomStatuses(auth.admin) : null;
  if (roomStatuses?.error) throw new Error("Room availability unavailable");
  let available = list;
  if (plan.roomIntent === "late-checkouts") {
    const threshold = checkoutMinutes(plan.checkoutAfter || "11:00") ?? 660;
    const date = dateBound(plan.fromDate) || roomStatuses?.date;
    available = available.filter((item) => {
      const id = validAskRoom(item.room_number || "");
      const operation = roomStatuses?.operations?.get(id);
      const checkout = checkoutMinutes(operation?.checkout_time || "");
      return !!id && operation?.checkout_date === date && checkout !== null && checkout > threshold;
    });
    if (!fullOperations && available.length) {
      const accessible = await authorizedCheckoutRooms(auth, available);
      available = available.filter((item) => accessible.has(validAskRoom(item.room_number || "")));
    }
  } else if (plan.roomIntent === "availability" && plan.roomAvailability) {
    const desired = plan.roomAvailability.toLowerCase();
    available = available.filter((item) => {
      const state = roomStatuses?.statuses?.get(validAskRoom(item.room_number || item.name)) || "";
      if (/^(?:available|ready|vacant ready|disponible|list[oa])$/.test(desired)) return roomStatusBadge(state)?.available === true;
      return !!state && state.toLowerCase().includes(desired);
    });
  }
  const items: AskResultItem[] = available.slice(0, maxItems).map((item) => {
    const id = validAskRoom(item.room_number || item.name) || roomKey(item.room_number || item.name);
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
        ...(plan.roomIntent === "late-checkouts" && operation?.checkout_time ? [...fact("Checkout time", dateTime(operation.checkout_time)), ...fact("Checkout date", operation.checkout_date)] : []),
      ],
    };
  });
  return { items, missing: plan.roomIntent === "features" ? "The room register has no verified amenity or designated-model field. Only matching authorized records support equipment or amenities." : available.length > maxItems ? "Room results are limited. Filter by room or state for more detail." : undefined };
}

function nativeGet(request: NextRequest, pathname: string) {
  const bearer = request.headers.get("authorization") || "";
  return new NextRequest(new URL(pathname, request.nextUrl.origin), { method: "GET", headers: { Authorization: bearer } });
}

async function rankingSource(request: NextRequest, plan: AskPlan, ids: string[] = []): Promise<SourceResult> {
  const { GET } = await import("@/app/api/ticket-room-ranker/route");
  const response = await GET(nativeGet(request, "/api/ticket-room-ranker"));
  if (!response.ok) throw new Error("Room Ranker unavailable");
  const data = await response.json();
  const values: Array<{ id: string; number: string; rank: string; issues?: unknown[] }> = data.rooms || [];
  return {
    items: values.filter((room) => (!ids.length || ids.includes(room.id)) && (!plan.rooms.length || plan.rooms.includes(validAskRoom(room.number))) && (!plan.rank || room.rank === plan.rank)).slice(0, maxItems).map((room) => ({
      id: "rank:" + room.id, title: titleRoom(room.number), source: "CMPRI · Room Ranker", sourceType: "internal",
      record: { kind: "roomRank", id: room.id, label: "Open Room Ranker" },
      facts: [...fact("Room", room.number), ...fact("Room rank", room.rank), ...fact("Ranked issues", String(room.issues?.length || 0))],
    })),
  };
}

async function notesSource(auth: Authorized, plan: AskPlan, personal: boolean, ids: string[] = []): Promise<SourceResult> {
  const { principal } = auth;
  const from = dateBound(plan.fromDate), to = dateBound(plan.toDate);
  if (!personal) {
    let query = auth.admin.from("cmpri_staff_notes").select("id,author_name,body,created_at").eq("hotel_id", principal.hotelId);
    if (ids.length) query = query.in("id", ids);
    else {
      if (/^(?:me|myself|yo)$/i.test(plan.noteAuthor || "")) query = query.eq("author_user_id", principal.identity.id);
      else if (plan.noteAuthor) query = query.ilike("author_name", plan.noteAuthor.replace(/[%_\\]/g, "\\$&"));
      if (from) query = query.gte("created_at", dateEdge(from));
      if (to) query = query.lt("created_at", dateEdge(nextDay(to)));
      const terms = plan.terms.filter((term) => term.toLowerCase() !== plan.noteAuthor?.toLowerCase());
      if (terms.length) query = query.or(terms.map((term) => "body.ilike." + literalPattern(term)).join(","));
    }
    const result = await query.order("created_at", { ascending: false }).limit(18);
    if (result.error) throw new Error("Staff Notes unavailable");
    return { items: (result.data || []).map((item) => ({
      id: "staff:" + item.id, title: askText(item.author_name, 100) || "Staff Notes",
      text: relevantExcerpt(item.body, plan.terms, 900), source: "CMPRI · Staff Notes", sourceType: "internal",
      record: { kind: "staffNote", id: item.id, label: "Open Staff Notes" },
      facts: [...fact("Author", item.author_name), ...fact("Created", item.created_at)],
    })) };
  }
  let query = auth.admin.from("cmpri_general_notes").select("id,title,text:document->>text,updated_at")
    .eq("hotel_id", principal.hotelId).eq("user_id", principal.identity.id).is("deleted_at", null);
  if (ids.length) query = query.in("id", ids);
  else {
    if (from) query = query.gte("updated_at", dateEdge(from));
    if (to) query = query.lt("updated_at", dateEdge(nextDay(to)));
    if (plan.terms.length) query = query.or(plan.terms.flatMap((term) => ["title", "document->>text"].map((field) => field + ".ilike." + literalPattern(term))).join(","));
  }
  const result = await query.order("updated_at", { ascending: false }).limit(18);
  if (result.error) throw new Error("Personal Notepad unavailable");
  return { items: (result.data || []).map((item) => ({
    id: "note:" + item.id, title: askText(item.title, 130) || "Personal note",
    text: relevantExcerpt(item.text, plan.terms, 900), source: "CMPRI · Personal Notepad", sourceType: "internal",
    record: { kind: "personalNote", id: item.id, label: "Open note" },
    facts: fact("Updated", item.updated_at),
  })) };
}

export async function readAskSources(request: NextRequest, auth: Authorized, plan: AskPlan, evidence: string[] = []) {
  const permitted = askPermittedSources(auth.principal);
  const requested = plan.sources.filter((name) => permitted.includes(name));
  const missing = plan.sources.filter((name) => !permitted.includes(name)).map((name) => name + " is outside this account’s access.");
  const settle = async <T>(promise: Promise<T>, name: string, empty: T) => {
    try { return await promise; }
    catch { if (!missing.includes(name + " is unavailable.")) missing.push(name + " is unavailable."); return empty; }
  };
  const ids = (kind: string) => evidence.filter((id) => id.startsWith(kind + ":")).map((id) => id.slice(kind.length + 1)).filter(isUuid).slice(0, maxItems);
  const [locations, orders] = await Promise.all([
    requested.some((name) => name === "rooms" || name === "assets") || plan.candidateAction === "create"
      ? settle(askLocations(auth, plan.rooms, plan.locationNames, ids("room")), "CMPRI room records", []) : [],
    requested.includes("orders") || ["status", "priority", "comment"].includes(plan.candidateAction)
      ? settle(askOrders(auth, ids("order").length ? { ...plan, workOrders: ids("order"), rooms: [], status: "all", ticketStatus: undefined } : plan), "CMPRI work orders", []) : [],
  ]);
  const assetIds = [...new Set(orders.map((order) => askText(order.asset_id, 50)).filter(isUuid))];
  const targeted = plan.rooms.length > 0 || Boolean(plan.locationNames?.length);
  const [assetMatches, associatedAssets] = await Promise.all([
    requested.includes("assets") ? settle(askAssets(auth, { rooms: targeted ? locations : [], terms: plan.terms, make: plan.manufacturer, model: plan.model, targetedRooms: targeted, state: plan.assetState, ids: ids("asset") }), "CMPRI equipment", []) : [],
    assetIds.length && canReadAskAssets(auth.principal) ? settle(askAssets(auth, { rooms: [], terms: [], ids: assetIds }), "Linked CMPRI equipment", []) : [],
  ]);
  const uniqueAssets = [...new Map([...associatedAssets, ...assetMatches].map((asset) => [asset.id, asset])).values()];
  const assets = await Promise.all(uniqueAssets.map((asset) => settle(verifyAskAsset(auth, asset, plan.webIntent === "manual" && uniqueAssets.length <= 2), "Equipment document verification", asset)));
  const linkedAssets = new Map(assets.map((item) => [item.id, item]));
  const independent = await Promise.all(requested.flatMap((name) => {
    if (name === "rooms") return [settle(roomSource(auth, plan, locations), "CMPRI room status", { items: [] })];
    if (name === "roomRank") return [settle(rankingSource(request, plan, ids("rank")), "CMPRI Room Ranker", { items: [] })];
    if (name === "staffNotes" || name === "personalNotes") return [settle(notesSource(auth, plan, name === "personalNotes", ids(name === "personalNotes" ? "note" : "staff")), name === "personalNotes" ? "Personal Notepad" : "Staff Notes", { items: [] })];
    return [];
  }));
  const groups = [
    requested.includes("orders") ? orders.map((order) => askOrderItem(order, true, linkedAssets.get(String(order.asset_id)), plan.terms)) : [],
    requested.includes("assets") ? assetMatches.map((asset) => assetItem(linkedAssets.get(asset.id) || asset, locations)) : [],
    ...independent.map(({ items }) => items),
  ].filter((group) => group.length);
  const items: AskResultItem[] = [];
  if (groups.reduce((count, group) => count + group.length, 0) <= 65) items.push(...groups.flat());
  else {
    for (let rowIndex = 0; rowIndex < maxItems && items.length < 65; rowIndex++) {
      for (const group of groups) if (group[rowIndex] && items.length < 65) items.push(group[rowIndex]);
    }
    missing.push("Results include a sample from each source. Narrow the question to see more from one source.");
  }
  missing.push(...independent.map((part) => part.missing).filter((entry): entry is string => Boolean(entry)));
  return { orders, locations, assets, items, missing };
}
