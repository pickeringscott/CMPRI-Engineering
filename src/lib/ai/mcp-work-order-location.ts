type WorkOrderLocation = {
  id: string;
  name: string | null;
  room_number: string | null;
};

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function resolveMcpWorkOrderLocation(room: string, locations: WorkOrderLocation[]) {
  const requested = normalized(room.replace(/^(room|rm)\s*/i, ""));
  const matches = locations.filter((location) =>
    normalized(location.room_number) === requested || normalized(location.name) === normalized(room) || normalized(location.name) === requested);

  if (matches.length === 0) return { status: "not_found" as const };
  if (matches.length > 1) return { status: "ambiguous" as const };
  return { status: "found" as const, location: matches[0] };
}
