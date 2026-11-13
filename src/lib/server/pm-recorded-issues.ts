import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HOTEL_ID } from '@/lib/constants';
import { PM_ROOM_TEMPLATE_ID } from '@/lib/pm/catalog';
import { recordedTemplate } from '@/lib/pm/recorded-catalog';
import { guardRecordedOverlaps, recordedProposal, recordedRoom, type RecordedIssueSource } from '@/lib/pm/recorded-issues';
import { fetchAllPages } from './paginated-query';

/** Read only; intentionally not bounded by the currently selected week/year. */
export async function loadRecordedIssueState(admin: SupabaseClient, userId: string) {
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
    const payload = record.payload as {responses?:Record<string,unknown>} | null;
    const { template, mixed } = recordedTemplate(String(record.template_id), payload?.responses);
    if (template) {
      const source = recordedProposal(template, record, userId);
      if (mixed) source.hold = 'This saved inspection mixes checklist versions. Reconcile its original answer identities before creating a work order.';
      sources.push(source);
    }
  }
  for (const record of rooms.data || []) {
    const { template, mixed } = recordedTemplate(PM_ROOM_TEMPLATE_ID, record.item_answers as Record<string,unknown>);
    if (template) {
      const source = recordedRoom(template, record);
      if (mixed) source.hold = 'This saved room inspection mixes checklist versions. Reconcile its original answer identities before creating a work order.';
      sources.push(source);
    }
  }
  return { sources: guardRecordedOverlaps(sources).filter(source => source.issues.length)
    .sort((a, b) => b.period.localeCompare(a.period) || a.title.localeCompare(b.title)),
    proposals: proposals.data || [], rooms: rooms.data || [] };
}

export async function loadRecordedIssues(admin: SupabaseClient, userId: string): Promise<RecordedIssueSource[]> {
  return (await loadRecordedIssueState(admin, userId)).sources;
}
