export type RoomOperationMoveRow = {
  room: string;
  guest_name?: string | null;
  move_from?: string | null;
  move_to?: string | null;
};

export function detectRoomMoves<T extends RoomOperationMoveRow>(
  yesterday: T[],
  today: T[],
): T[] {
  const previousByGuest = new Map<string, T[]>();
  const currentByGuest = new Map<string, T[]>();

  for (const row of yesterday) {
    const guest = String(row.guest_name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
    if (guest) previousByGuest.set(guest, [...(previousByGuest.get(guest) || []), row]);
  }
  for (const row of today) {
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
      move_from: move?.move_from || "",
      move_to: move?.move_to || "",
    };
  });
}
