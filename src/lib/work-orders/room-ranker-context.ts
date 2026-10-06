export type RoomRankerContext = {
  rowNumber?: number;
  room: string;
  rank?: string;
  check1?: string;
  check2?: string;
  check3?: string;
  notes?: string;
};

export type RoomRankerContextResult = {
  ranker: RoomRankerContext | null;
  error: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function roomContext(value: unknown): RoomRankerContext | null {
  if (!isRecord(value) || typeof value.room !== "string") return null;
  return {
    rowNumber: typeof value.rowNumber === "number" ? value.rowNumber : undefined,
    room: value.room,
    rank: textField(value.rank),
    check1: textField(value.check1),
    check2: textField(value.check2),
    check3: textField(value.check3),
    notes: textField(value.notes),
  };
}

export function resolveRoomRankerContext(
  responseOk: boolean,
  payload: unknown,
  room: string,
): RoomRankerContextResult {
  if (!isRecord(payload)) {
    return {
      ranker: null,
      error: responseOk ? "Room Ranker returned an invalid response." : "Room Ranker could not be loaded.",
    };
  }
  if (!responseOk) {
    return {
      ranker: null,
      error: typeof payload.error === "string" && payload.error.trim()
        ? payload.error
        : "Room Ranker could not be loaded.",
    };
  }
  if (!Array.isArray(payload.rooms)) {
    return { ranker: null, error: "Room Ranker returned an invalid response." };
  }
  const ranker = payload.rooms
    .map(roomContext)
    .find((entry) => entry?.room.trim() === room) || null;
  return { ranker, error: "" };
}
