import type { AskContext, AskResponse, AskResultItem, AskTableCell } from "@/lib/ask-cmpri/types";

export const roomPracticePrompts = [
  "Does 134 have a sofa bed?",
  "Any maintenance issues there?",
  "Put that in a table",
  "Add a priority column and sort by priority",
] as const;

const orders = [
  { number: "1086", room: "134", issue: "Bathroom faucet is leaking.", status: "Open", repair: "Repair pending", priority: "High", assignee: "Jordan Lee" },
  { number: "1083", room: "134", issue: "Bedside outlet does not work.", status: "In Progress", repair: "Testing is in progress.", priority: "Medium", assignee: "Alex Rivera" },
  { number: "1078", room: "134", issue: "Bathroom towel bar was loose.", status: "Completed", repair: "Tightened and checked the towel bar. The repair is complete and ticket closure is pending.", priority: "Low", assignee: "Jordan Lee" },
  { number: "1063", room: "134", issue: "Sofa bed latch stuck.", status: "Closed", repair: "Adjusted the latch and checked the sofa bed. The verified repair is complete and the ticket is closed.", priority: "Medium", assignee: "Alex Rivera" },
] as const;

export const workOrderPracticeId = "guide-wo-1042";
const microwave = {
  number: "1042", room: "214", issue: "Runs but does not heat.", status: "Open",
  repair: "Display and controls respond. Microwave removed from guest use for review.", priority: "Medium", assignee: "Alex Rivera",
};

export function practiceWorkOrder(id: string) {
  return [microwave, ...orders].find(order => `guide-wo-${order.number}` === id);
}

function orderResult(order: NonNullable<ReturnType<typeof practiceWorkOrder>>): AskResultItem {
  const record = { kind: "order" as const, id: `guide-wo-${order.number}`, label: `WO#${order.number}` };
  return {
    id: record.id,
    title: `Room ${order.room} · ${record.label}`,
    text: order.issue,
    source: "Practice · CMPRI Work orders",
    sourceType: "internal",
    record,
    facts: [
      { label: "Ticket status", value: order.status }, { label: "Repair status", value: order.repair },
      { label: "Priority", value: order.priority }, { label: "Assigned to", value: order.assignee },
    ],
  };
}

export function practiceAskResponse(question: string, previous?: AskContext): AskResponse {
  const query = question.toLowerCase().trim();
  const roomContext: AskContext = { language: "en", rooms: ["134"], sources: ["rooms"] };
  const orderContext: AskContext = { ...roomContext, sources: ["orders"], workOrders: orders.map(order => order.number) };
  if (/\b(?:furniture|sofa|king studio)\b/.test(query)) return {
    title: "Room 134 has a queen-size sofa bed",
    summary: "Room 134 is a King Studio with one queen-size sofa bed.",
    items: [{ id: "guide-room-134", title: "Room 134", text: "King Studio · One queen-size sofa bed", source: "Practice · CMPRI Rooms", sourceType: "internal" }],
    context: roomContext,
  };
  if (/\b(?:salt|ice melt)\b/.test(query)) return {
    title: "Ice melt storage", summary: "Ice melt is in the blue-lid bin in the Engineering cage by the loading dock. Spare bags are on the lower shelf.",
    context: { language: "en", sources: ["staffNotes"] },
  };
  const target = [microwave, ...orders].find(order => new RegExp(`\\b${order.number}\\b`).test(query));
  if (target || /\bmicrowave\b/.test(query)) {
    const order = target || microwave;
    return { title: `WO#${order.number}`, summary: order.issue, items: [orderResult(order)], context: { sources: ["orders"], rooms: [order.room], workOrders: [order.number] } };
  }
  const priority = /\bpriority\b/.test(query);
  if ((priority || /\btable\b/.test(query)) && previous?.rooms?.includes("134")) {
    const labels = ["Room", "Reported issue", "Work order", "Ticket status", "Repair status", ...(priority ? ["Priority"] : [])];
    const ranks: Record<string, number> = { High: 3, Medium: 2, Low: 1 };
    const rows = priority ? [...orders].sort((left, right) => ranks[right.priority] - ranks[left.priority]) : orders;
    return {
      title: "Room 134 maintenance", summary: "Four sample work orders for Room 134.", format: "table",
      table: {
        columns: labels.map(label => ({ id: label, label })),
        rows: rows.map(order => {
          const item = orderResult(order);
          const cells: Record<string, AskTableCell> = {
            Room: order.room, "Reported issue": order.issue, "Work order": { text: item.record!.label!, record: item.record },
            "Ticket status": order.status, "Repair status": order.repair,
            ...(priority ? { Priority: order.priority } : {}),
          };
          return { id: item.id, cells };
        }),
      },
      context: { ...orderContext, format: "table", fields: labels },
    };
  }
  if (/\b(?:maintenance|issues|repairs)\b/.test(query) && (previous?.rooms?.includes("134") || /\b134\b/.test(query))) return {
    title: "Room 134 maintenance", summary: "Four sample work orders cover two active issues, one completed repair and one closed repair.",
    items: orders.map(orderResult), context: orderContext,
  };
  return { title: "Practice with sample records", summary: `Try “${roomPracticePrompts[0]}” or “Where is the salt stored?”`, context: previous };
}
