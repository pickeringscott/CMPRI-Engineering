"use client";
import LoyaltyBadge from './LoyaltyBadge';
import GuestGroupBadge from './GuestGroupBadge';
import { loyaltyTier } from '@/lib/loyalty-tier';
import type { RoomGroupBadge } from '@/lib/room-group-badges';

export default function WorkOrderGuestIndicators({ guest, showName = true }: { guest: Record<string, unknown>; showName?: boolean }) {
  const badge = (value: unknown): RoomGroupBadge | null => value === 'railway-cn' || value === 'big-ten' || value === 'flyover-studios' ? value : null;
  const name = typeof guest.guest_name === 'string' ? guest.guest_name : '';
  return <span className="cmpri-window-guest" aria-label="Guest information">
    {showName && name && <span className="cmpri-window-guest-name" title={name}>{name}</span>}
    <LoyaltyBadge tier={loyaltyTier(guest.loyalty_tier)} />
    <GuestGroupBadge badge={badge(guest.guest_group_badge)} className="preview-group-badge" />
    {guest.incoming_reserved === true && <><GuestGroupBadge badge={badge(guest.incoming_group_badge)} className="preview-group-badge" /><LoyaltyBadge tier={loyaltyTier(guest.incoming_loyalty_tier)} /><span className="reserved-pill">Reserved</span></>}
  </span>;
}
