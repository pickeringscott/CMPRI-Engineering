import type { SupabaseClient } from '@supabase/supabase-js';
import type { Principal } from './access';
import { canUseWinterPreparedness } from '../winter-preparedness-access';
import { WINTER_TASK_IDS, WINTER_YEAR, type WinterItem } from '../winter-preparedness';

export class WinterStoreError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export function winterHotel(principal: Principal, mcp = false): string {
  if (mcp || !principal.identity.id || !principal.hotelId
    || principal.profile.id !== principal.identity.id || principal.profile.active !== true
    || principal.membership.active !== true || principal.membership.user_id !== principal.identity.id
    || principal.membership.hotel_id !== principal.hotelId || !canUseWinterPreparedness(principal.profile)) {
    throw new WinterStoreError('Winter Preparedness requires an authorized active hotel account.', 403);
  }
  return principal.hotelId;
}
const TABLE = 'cmpri_winter_items';
const COLUMNS = 'item_id,checked,revision,changed_by,changed_by_name,changed_at';
export async function readWinter(client: SupabaseClient, principal: Principal, mcp = false): Promise<WinterItem[]> {
  const hotel = winterHotel(principal, mcp);
  const { data, error } = await client.from(TABLE).select(COLUMNS).eq('hotel_id', hotel).eq('year', WINTER_YEAR);
  if (error) throw new WinterStoreError('Checklist storage is unavailable. Please retry.', 503);
  return (data || []) as WinterItem[];
}
export async function saveWinter(client: SupabaseClient, principal: Principal, input: unknown, mcp = false): Promise<WinterItem> {
  const hotel = winterHotel(principal, mcp);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WinterStoreError('Invalid checklist change.', 400);
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !['item_id', 'checked', 'revision'].includes(key))
    || typeof body.item_id !== 'string' || !WINTER_TASK_IDS.includes(body.item_id)
    || typeof body.checked !== 'boolean' || !Number.isSafeInteger(body.revision)
    || (body.revision as number) < 0 || (body.revision as number) >= 2147483647) throw new WinterStoreError('Invalid checklist change.', 400);
  const value = { checked: body.checked, revision: (body.revision as number) + 1,
    changed_by: principal.identity.id, changed_by_name: principal.profile.full_name?.trim() || principal.identity.email || principal.identity.id };
  // Atomic compare-and-swap per item: another user's changes cannot be silently replaced.
  const query = body.revision === 0
    ? client.from(TABLE).insert({ ...value, hotel_id: hotel, year: WINTER_YEAR, item_id: body.item_id })
    : client.from(TABLE).update(value).eq('hotel_id', hotel).eq('year', WINTER_YEAR).eq('item_id', body.item_id).eq('revision', body.revision);
  const { data, error } = await query.select(COLUMNS).maybeSingle();
  if (error?.code === '23505' || (!error && !data)) throw new WinterStoreError('This item changed elsewhere. Reload the checklist before changing it.', 409);
  if (error) throw new WinterStoreError('Change was not confirmed saved. Reload the checklist before retrying.', 503);
  return data as WinterItem;
}
