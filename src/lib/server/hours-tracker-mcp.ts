import type { McpIdentity } from './cmpri-mcp';
import { hoursOwner, HoursStoreError, readHours, saveHours } from './hours-tracker-store';

const OWNER = '750f77bf-7d5d-4ca6-8421-e025edea87ba';
/** Dedicated MCP adapter: never enables general API access or clock actions. */
export function canUseHoursMcp(identity: McpIdentity): boolean {
  try { return hoursOwner(identity.principal) === OWNER; } catch { return false; }
}
function authorize(identity: McpIdentity) {
  if (!canUseHoursMcp(identity)) throw new HoursStoreError('This private timesheet is unavailable to this connection.', 403);
}
export async function readHoursMcp(identity: McpIdentity, input: Record<string, unknown>) {
  authorize(identity);
  if (Object.keys(input).some(key => key !== 'view')) throw new HoursStoreError('Timesheet reads do not accept account selectors or filters.', 400);
  return { saved: await readHours(identity.admin, identity.principal) };
}
export async function saveHoursMcp(identity: McpIdentity, input: Record<string, unknown>) {
  authorize(identity);
  if (!identity.canWrite) throw new HoursStoreError('This connection has read-only access.', 403);
  if (!Object.hasOwn(input, 'period') || Object.keys(input).some(key => !['period', 'revision', 'confirmRateChange'].includes(key))) {
    throw new HoursStoreError('Save one complete period only; configuration and account selectors are not permitted.', 400);
  }
  if (JSON.stringify(input).length > 32000) throw new HoursStoreError('Hours request is too large.', 413);
  return { saved: await saveHours(identity.admin, identity.principal, input) };
}
