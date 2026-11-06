export const LOYALTY_TIERS = ['Base', 'Silver', 'Gold', 'Platinum', 'Titanium', 'Ambassador'] as const;
export type LoyaltyTier = typeof LOYALTY_TIERS[number];
/** Only imported, recognized membership values produce a badge; blank/unknown is not Base. */
export function loyaltyTier(value: unknown): LoyaltyTier | null {
  if (typeof value !== 'string') return null;
  const label = value.trim().replace(/^marriott\s+bonvoy\s+|^bonvoy\s+/i, '').replace(/\s+elite$/i, '').toLowerCase();
  if (label === 'member' || label === 'base member') return 'Base';
  return LOYALTY_TIERS.find(tier => tier.toLowerCase() === label) || null;
}
export function loyaltyRank(value: unknown): number { const tier = loyaltyTier(value); return tier ? LOYALTY_TIERS.indexOf(tier) + 1 : 0; }
