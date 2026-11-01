import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HOTEL_ID } from '@/lib/constants';
import { findPmTemplate, PM_ROOM_TEMPLATE_ID } from '@/lib/pm/catalog';
import { guardRecordedOverlaps, recordedProposal, recordedRoom, type RecordedIssueSource } from '@/lib/pm/recorded-issues';
import { fetchAllPages } from './paginated-query';

/** Read only; intentionally not bounded by the currently selected week/year. */
export async function loadRecordedIssues(admin: SupabaseClient, userId: string): Promise<RecordedIssueSource[]> {
  const [proposals, rooms] = await Promise.all([
    fetchAllPages<Record<string, unknown>>((from, to) => admin.from('cmpri_pm_proposals')
      .select('id,template_id,period_start,scope_key,payload,revision,status,submitted_by')
      .eq('hotel_id', HOTEL_ID).neq('status', 'rejected').order('id').range(from, to)),
    fetchAllPages<Record<string, unknown>>((from, to) => admin.from('cmpri_room_pm_history')
      .select('room,period_start,completed_on,item_answers').eq('hotel_id', HOTEL_ID)
      .order('room').order('period_start').range(from, to)),
  ]);
  if (proposals.error || rooms.error) throw new Error('Recorded inspections could not be loaded. No tickets were created.');
  const sources: RecordedIssueSource[] = [];
  for (const record of proposals.data || []) {
    const template = findPmTemplate(String(record.template_id));
    if (template) sources.push(recordedProposal(template, record, userId));
  }
  const template = findPmTemplate(PM_ROOM_TEMPLATE_ID);
  if (template) for (const record of rooms.data || []) sources.push(recordedRoom(template, record));
  return guardRecordedOverlaps(sources).filter(source => source.issues.length)
    .sort((a, b) => b.period.localeCompare(a.period) || a.title.localeCompare(b.title));
}
