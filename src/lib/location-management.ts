export type LocationListRecord = { id: string; name: string | null; room_number: string | null; location_type: string | null };
const compare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

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
