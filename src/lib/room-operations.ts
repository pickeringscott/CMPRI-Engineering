export type RoomOperationMoveRow = {
  room: string;
  guest_name?: string | null;
  guest_code?: string | null;
  move_from?: string | null;
  move_to?: string | null;
};

export type RoomOperationSummaryRow = {
  room: string;
  checkout_date?: string | null;
  room_status?: string | null;
};

export type CheckoutRoomWorkOrder = {
  room: string;
  display_id: string | null;
  issue: string;
  status: string;
};

export function isRailwayCnGuestName(value: string | null | undefined) {
  return /railway\s*\/\s*cn/i.test(value || "");
}

export function summarizeRoomOperations(rows: RoomOperationSummaryRow[], reportDate: string) {
  const outOfOrderRooms = rows
    .filter((row) => {
      const status = String(row.room_status || "").trim().toLocaleLowerCase("en-US");
      return status === "ooo" || status.includes("out of order") || status.includes("out-of-order");
    })
    .map((row) => ({ room: row.room, status: String(row.room_status || "").trim() }));

  return {
    checkoutCount: rows.filter((row) => row.checkout_date === reportDate).length,
    outOfOrderRooms,
  };
}

export function formatCheckoutRoomWorkOrders(workOrders: CheckoutRoomWorkOrder[] | null) {
  if (workOrders === null) return "Open work orders in checkout rooms: unable to check.";
  if (!workOrders.length) return "Open work orders in checkout rooms: none.";
  return `Open work orders in checkout rooms: ${workOrders
    .map(({ room, display_id, issue, status }) =>
      `Room ${room} — ${display_id || "Work order"} (${status}): ${issue}`
    )
    .join("; ")}.`;
}

export function detectRoomMoves<T extends RoomOperationMoveRow>(
  yesterday: T[],
  today: T[],
): T[] {
  const previousByGuest = new Map<string, T[]>();
  const currentByGuest = new Map<string, T[]>();

  for (const row of yesterday) {
    if (String(row.guest_code || "").trim().toLocaleUpperCase("en-US") === "RCNA") continue;
    const guest = String(row.guest_name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
    if (guest) previousByGuest.set(guest, [...(previousByGuest.get(guest) || []), row]);
  }
  for (const row of today) {
    if (String(row.guest_code || "").trim().toLocaleUpperCase("en-US") === "RCNA") continue;
    const guest = String(row.guest_name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
    if (guest) currentByGuest.set(guest, [...(currentByGuest.get(guest) || []), row]);
  }

  const movesByRoom = new Map<string, { move_from: string; move_to: string }>();
  for (const [guest, currentRows] of currentByGuest) {
    const previousRows = previousByGuest.get(guest) || [];
    if (currentRows.length !== 1 || previousRows.length !== 1) continue;
    const previous = previousRows[0];
    const current = currentRows[0];
    if (previous.room === current.room) continue;
    movesByRoom.set(current.room, { move_from: previous.room, move_to: current.room });
  }

  return today.map((row) => {
    const move = movesByRoom.get(row.room);
    return {
      ...row,
      move_from: move?.move_from || row.move_from || "",
      move_to: move?.move_to || row.move_to || "",
    };
  });
}
