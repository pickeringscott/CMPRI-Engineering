"use client";

import GuestGroupBadge from "@/components/GuestGroupBadge";
import LoyaltyBadge from "@/components/LoyaltyBadge";
import { loyaltyTier } from "@/lib/loyalty-tier";
import type { RoomGroupBadge } from "@/lib/room-group-badges";

/** The in-house guest takes precedence until checkout, then the incoming reservation. */
export default function WorkOrderTitleGuest({ guest }: { guest: Record<string, unknown> }) {
  const name = typeof guest.guest_name === "string" ? guest.guest_name.trim() : "";
  const reservedName = typeof guest.incoming_name === "string" ? guest.incoming_name.trim() : "";
  const occupied = typeof guest.room_status === "string" && /\boccupied\b/i.test(guest.room_status);
  const reserved = !name && !occupied && guest.incoming_reserved === true;
  if (!name && !reserved && !occupied) return null;
  const group = reserved ? guest.incoming_group_badge : guest.guest_group_badge;
  const badge: RoomGroupBadge | null = group === "railway-cn" || group === "big-ten" || group === "flyover-studios" ? group : null;
  const tier = loyaltyTier(reserved ? guest.incoming_loyalty_tier : guest.loyalty_tier);
  const displayName = reserved ? reservedName : name;
  return <span className="cmpri-title-guest" aria-label={`${reserved ? "Reserved guest" : occupied ? "Occupied guest" : "Guest"}${displayName ? `: ${displayName}` : ""}`}>
    {reserved && <span className="reserved-pill">Reserved</span>}
    {occupied && <span className="cmpri-title-occupied">Occupied</span>}
    <GuestGroupBadge badge={badge} className="cmpri-title-guest-badge" />
    <LoyaltyBadge tier={tier} />
    {displayName && <span className="cmpri-title-guest-name">{displayName}</span>}
  </span>;
}
