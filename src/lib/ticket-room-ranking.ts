export type RoomRank = "A" | "B" | "C";
export type RankingLocation = { id: string; room_number: string | null; name: string; location_type: string; active: boolean };
export type RankingTicket = { id: string; location_id: string | null; room: string | null; issue: string; priority: string; ranker_base_priority?: string | null; status: string };
export type RankedRoom = { id: string; number: string; floor: string; rank: RoomRank; issues: RankingTicket[] };

const excluded = new Set(["Completed", "Closed", "Will Not Do"]);
const priorityOrder: Record<string, number> = { Urgent: 3, High: 2, Medium: 1, Low: 0 };

/** Only CMPRI inventory defines rooms; a general location numbered 112 is not room 112. */
export function rankTicketRooms(locations: RankingLocation[], tickets: RankingTicket[]): RankedRoom[] {
  const rooms = locations.filter((room) => room.active && room.location_type === "Guest Room" && room.room_number);
  const byId = new Map(rooms.map((room) => [room.id, room]));
  // Match the database's deterministic first ID if inventory names repeat.
  const byName = new Map<string, RankingLocation>();
  for (const room of rooms) {
    const existing = byName.get(room.name);
    if (!existing || room.id < existing.id) byName.set(room.name, room);
  }
  const issues = new Map<string, RankingTicket[]>();
  for (const ticket of tickets) {
    if (excluded.has(ticket.status)) continue;
    // A supplied location ID is authoritative. Never attach a hall ticket by a reused room number.
    const room = ticket.location_id ? byId.get(ticket.location_id) : byName.get(ticket.room || "");
    if (!room) continue;
    if (!Object.hasOwn(priorityOrder, ticket.priority) || !Object.hasOwn(priorityOrder, ticket.ranker_base_priority ?? ticket.priority)) throw new Error("A room ticket has an unrecognized priority.");
    const list = issues.get(room.id) || [];
    list.push(ticket);
    issues.set(room.id, list);
  }
  return rooms.map((room): RankedRoom => {
    // Automatic escalation can give every ticket the same display priority.
    // Prefer the higher original priority before falling back to a stable ID.
    const list = (issues.get(room.id) || []).sort((a, b) =>
      priorityOrder[b.priority] - priorityOrder[a.priority]
      || priorityOrder[b.ranker_base_priority ?? b.priority] - priorityOrder[a.ranker_base_priority ?? a.priority]
      || a.id.localeCompare(b.id));
    // Escalated priorities are display priorities. Use the preserved original
    // priorities for counts so an automatic escalation cannot feed itself.
    const counts = { Low: 0, Medium: 0, High: 0, Urgent: 0 };
    for (const ticket of list) counts[(ticket.ranker_base_priority ?? ticket.priority) as keyof typeof counts]++;
    const rank: RoomRank = counts.High || counts.Urgent || counts.Low >= 4 || counts.Medium >= 3 ? "C"
      : counts.Medium || counts.Low >= 3 ? "B" : "A";
    return { id: room.id, number: room.room_number!, floor: room.room_number!.slice(0, 1),
      rank, issues: list };
  }).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

export function roomRankCounts(rooms: RankedRoom[]) {
  const counts = { A: 0, B: 0, C: 0 };
  for (const room of rooms) counts[room.rank]++;
  return counts;
}

export function readRankingFloorState(value: string | null): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([floor, open]) => /^\d$/.test(floor) && typeof open === "boolean"));
  } catch { return {}; }
}
