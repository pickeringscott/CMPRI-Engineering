export type LocationListRecord = { id: string; name: string | null; room_number: string | null; location_type: string | null };
const compare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

type LocationTicket = { location_id: string | null; room: string | null };

export function locationTicketMatcher(locations: readonly Pick<LocationListRecord, 'id' | 'name' | 'room_number'>[]) {
  const ids = new Set(locations.map(location => location.id));
  const aliases = new Map<string, string | null>();
  for (const location of locations) {
    for (const value of [location.name, location.room_number]) {
      const label = value?.trim().toLowerCase();
      if (!label) continue;
      aliases.set(label, !aliases.has(label) || aliases.get(label) === location.id ? location.id : null);
    }
  }

  return (ticket: LocationTicket) => {
    if (ticket.location_id) return ids.has(ticket.location_id) ? ticket.location_id : null;
    const room = ticket.room?.trim().toLowerCase();
    if (!room) return null;
    const number = room.replace(/^(?:(?:room|rm)\s+)?#?\s*/, '');
    const legacyNumber = number.match(/^(\d{2,4})(?![-\w])/)?.[1];
    for (const alias of [room, number, legacyNumber]) {
      if (alias && aliases.has(alias)) return aliases.get(alias) ?? null;
    }
    return null;
  };
}

export function groupLocations<T extends LocationListRecord>(locations: readonly T[]) {
  const groups = new Map<string, { type: string; locations: T[] }>();
  for (const location of locations) {
    const type = location.location_type?.trim() || 'Unclassified';
    const key = type.toLocaleLowerCase('en');
    const group = groups.get(key) || { type, locations: [] };
    group.locations.push(location);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => compare(a.type, b.type)).map(group => ({
    ...group,
    locations: group.locations.sort((a, b) => compare(a.room_number || a.name || '', b.room_number || b.name || '') || compare(a.id, b.id)),
  }));
}
