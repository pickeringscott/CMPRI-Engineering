import type { Principal } from './access';
import { hoursOwner } from './hours-tracker-store';
/** Deliberately off until separately approved activation for exact owner IDs. */
export function hoursClockEnabled(principal: Principal): boolean {
  if (process.env.CMPRI_HOURS_CLOCK_ENABLED !== 'true') return false;
  try { return (process.env.CMPRI_HOURS_CLOCK_OWNER_IDS || '').split(',').map(value => value.trim()).includes(hoursOwner(principal)); }
  catch { return false; }
}
