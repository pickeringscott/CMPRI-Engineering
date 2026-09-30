import { detectRoomMoves } from "@/lib/room-operations";
import type { WorkOrderNotification } from "@/lib/dashboard/work-order-notifications";

type RoomOperationNotificationRow = {
  room: string;
  room_status: string | null;
  guest_name: string | null;
  guest_code?: string | null;
  move_from?: string | null;
  move_to?: string | null;
};

function isOutOfOrder(status: string | null) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "ooo" || normalized.includes("out of order") || normalized.includes("out-of-order");
}

export function roomOperationsNotification(
  importId: string,
  reportDate: string,
  rows: RoomOperationNotificationRow[],
  yesterdayRows: RoomOperationNotificationRow[],
  recordedAt = new Date().toISOString(),
): WorkOrderNotification | null {
  const outOfOrder = rows.filter((row) => isOutOfOrder(row.room_status));
  const withMoves = detectRoomMoves(yesterdayRows, rows);
  const moves = withMoves.filter((row) => row.move_from || row.move_to);
  if (!outOfOrder.length && !moves.length) return null;

  const sections = [
    outOfOrder.length
      ? `Out of order: ${outOfOrder.map((row) => `${row.room} (${row.room_status})`).join(", ")}.`
      : "",
    moves.length
      ? `Room moves: ${moves.map((row) => `${row.move_from} → ${row.move_to}`).join(", ")}.`
      : "",
  ].filter(Boolean);

  return {
    id: `room-operations:${importId}`,
    work_order_id: null,
    target_path: "/engineering/room-operations",
    message: `Daily room operations imported for ${reportDate}. ${sections.join(" ")}`,
    recorded_at: recordedAt,
  };
}
