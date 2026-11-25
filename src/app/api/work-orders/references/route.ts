import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { workOrderReader } from "@/lib/server/work-order-reader";
import { workOrderNumber } from "@/lib/work-order-reference.js";
import { canReadWorkOrder } from "@/lib/work-order-read-policy";

const headers = { "Cache-Control": "private, no-store" };
const columns = "id, display_id, hotel_id, room, issue, status";
const uuid = (hex: string) => `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;

/** Resolve specific history targets independently of the recent-ticket suggestion list. */
export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401, headers });
  const reader = workOrderReader(auth.principal);
  if (!reader.canRead) return NextResponse.json({ error: "Work-order access is required." }, { status: 403, headers });
  const targets = [...new Set(request.nextUrl.searchParams.getAll("target"))];
  if (targets.length > 100 || targets.some(target => !/^(?:number:[0-9]{1,30}|id:[a-f0-9]{8,32})$/.test(target))) {
    return NextResponse.json({ error: "Invalid work-order references." }, { status: 400, headers });
  }
  const query = request.nextUrl.searchParams.get("q")?.trim() || "";
  if (query.length > 200) {
    return NextResponse.json({ error: "Invalid work-order search." }, { status: 400, headers });
  }
  if (query) {
    const number = workOrderNumber(query);
    const pattern = JSON.stringify(`%${query.replace(/[%_\\*]/g, "\\$&")}%`);
    const expressions = [`issue.ilike.${pattern}`];
    if (number) expressions.unshift(`display_id.ilike.${JSON.stringify(`%${number}%`)}`);
    const { data, error } = await auth.admin.from("work_orders").select(columns)
      .eq("hotel_id", reader.hotelId).or(expressions.join(","))
      .order("created_at", { ascending: false }).order("id").limit(20);
    if (error) return NextResponse.json({ error: "Work-order search failed." }, { status: 503, headers });
    return NextResponse.json({ tickets: (data || []).filter(row => canReadWorkOrder(reader, row)) }, { headers });
  }
  const tickets = new Map<string, Record<string, unknown>>();
  const resolvedPrefixes: Record<string, string> = {};
  const numbers = targets.filter(target => target.startsWith("number:")).map(target => target.slice(7));
  if (numbers.length) {
    const values = numbers.flatMap(number => [number, `workorder_${number}`, `WO-${number}`, `WO#${number}`]);
    const { data, error } = await auth.admin.from("work_orders").select(columns)
      .eq("hotel_id", reader.hotelId).in("display_id", values);
    if (error) return NextResponse.json({ error: "Ticket references could not be loaded." }, { status: 503, headers });
    for (const row of data || []) if (canReadWorkOrder(reader, row)) tickets.set(row.id, row);
  }
  const ids = targets.filter(target => target.startsWith("id:")).map(target => target.slice(3));
  const fullIds = ids.filter(id => id.length === 32);
  if (fullIds.length) {
    const { data, error } = await auth.admin.from("work_orders").select(columns)
      .eq("hotel_id", reader.hotelId).in("id", fullIds.map(uuid));
    if (error) return NextResponse.json({ error: "Ticket references could not be loaded." }, { status: 503, headers });
    for (const row of data || []) {
      if (!canReadWorkOrder(reader, row)) continue;
      tickets.set(row.id, row);
      resolvedPrefixes[row.id.replaceAll("-", "")] = row.id;
    }
  }
  for (const prefix of ids.filter(id => id.length < 32)) {
    const { data, error } = await auth.admin.from("work_orders").select(columns)
      .eq("hotel_id", reader.hotelId)
      .gte("id", uuid(prefix.padEnd(32, "0"))).lte("id", uuid(prefix.padEnd(32, "f"))).limit(2);
    if (error) return NextResponse.json({ error: "Ticket references could not be loaded." }, { status: 503, headers });
    // Ambiguous legacy prefixes remain plain text rather than linking to the wrong ticket.
    if (data?.length === 1 && canReadWorkOrder(reader, data[0])) {
      tickets.set(data[0].id, data[0]);
      resolvedPrefixes[prefix] = data[0].id;
    }
  }
  return NextResponse.json({ tickets: [...tickets.values()], resolvedPrefixes }, { headers });
}
