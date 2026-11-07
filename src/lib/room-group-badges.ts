import { isBigTenGroup, isRailwayCnGuestName } from './room-operations';

export type RoomGroupBadge = 'big-ten' | 'flyover-studios' | 'railway-cn';

/** Match imported group/company labels, never guest names or arbitrary substrings. */
export function roomGroupBadge(value: unknown): RoomGroupBadge | null {
  if (typeof value !== 'string') return null;
  const group = value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (group === 'cn' || group === 'canadian national' || group === 'canadian national railway' || isRailwayCnGuestName(group)) return 'railway-cn';
  if (group === 'flyover studios' || group === 'flyover film studios') return 'flyover-studios';
  return isBigTenGroup(value) ? 'big-ten' : null;
}

/** Railway/CN is a legacy PMS guest label; other brands must come from group/company fields. */
function guestBadge(group: unknown, company: unknown, name: unknown): RoomGroupBadge | null {
  return roomGroupBadge(group) ?? roomGroupBadge(company)
    ?? (typeof name === 'string' && isRailwayCnGuestName(name) ? 'railway-cn' : null);
}

/** Consume the already projected occupancy snapshot; do not infer a guest or change arrival times. */
export function currentRoomGroupBadges(row: Record<string, unknown>) {
  const current = typeof row.guest_name === 'string' && !!row.guest_name.trim();
  const incoming = (row.reserved === true || row.incoming_reserved === true)
    && typeof row.incoming_name === 'string' && !!row.incoming_name.trim();
  return {
    guest_group_badge: current ? guestBadge(row.group_name, row.company, row.guest_name) : null,
    incoming_group_badge: incoming ? guestBadge(null, row.incoming_company, row.incoming_name) : null,
  };
}
