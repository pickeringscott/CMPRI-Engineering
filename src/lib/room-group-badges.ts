import { isBigTenGroup } from './room-operations';

export type RoomGroupBadge = 'big-ten' | 'flyover-studios';

/** Match imported group/company labels, never guest names or arbitrary substrings. */
export function roomGroupBadge(value: unknown): RoomGroupBadge | null {
  if (typeof value !== 'string') return null;
  const group = value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (group === 'flyover studios' || group === 'flyover film studios') return 'flyover-studios';
  return isBigTenGroup(value) ? 'big-ten' : null;
}

/** Consume the already projected occupancy snapshot; do not infer a guest or change arrival times. */
export function currentRoomGroupBadges(row: Record<string, unknown>) {
  const current = typeof row.guest_name === 'string' && !!row.guest_name.trim();
  const incoming = (row.reserved === true || row.incoming_reserved === true)
    && typeof row.incoming_name === 'string' && !!row.incoming_name.trim();
  return {
    guest_group_badge: current ? roomGroupBadge(row.group_name || row.company) : null,
    incoming_group_badge: incoming ? roomGroupBadge(row.incoming_company) : null,
  };
}
