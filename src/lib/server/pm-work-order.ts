import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HOTEL_ID } from '@/lib/constants';
import { recordedTemplate } from '@/lib/pm/recorded-catalog';
import { pmIssueCandidates, pmIssueExternalId } from '@/lib/pm/issues';
import { reviewedRecordedIssue } from '@/lib/pm/recorded-issues';
import { isUuid } from '@/lib/uuid';
import { loadRecordedIssueState } from './pm-recorded-issues';

export class PmSubmissionError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

/** Prepare the user's selected issue; the existing RPC rechecks its source atomically. */
export async function preparePmSubmission(admin: SupabaseClient, actorId: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PmSubmissionError('Review one saved PM issue before confirming.', 400);
  const input = value as Record<string, unknown>;
  if (input.confirmed !== true || typeof input.issueKey !== 'string') throw new PmSubmissionError('Explicit confirmation of the saved PM issue is required.', 400);
  let context: { templateId: string; title: string; period: string; scope: string };
  let candidate: ReturnType<typeof pmIssueCandidates>[number];
  let guard: Record<string, unknown>;
  if (input.recordedSource) {
    if (typeof input.recordedSource !== 'object' || Array.isArray(input.recordedSource)) throw new PmSubmissionError('Select a recorded inspection.', 400);
    const ref = input.recordedSource as Record<string, unknown>;
    const state = await loadRecordedIssueState(admin, actorId);
    const source = state.sources.find(row => row.kind === ref.kind && row.id === ref.id);
    if (!source) throw new PmSubmissionError('Recorded inspection not found. Reload the review.');
    try { candidate = reviewedRecordedIssue(source, input); }
    catch (error) { throw new PmSubmissionError(error instanceof Error ? error.message : 'Review the recorded issue again.'); }
    context = { templateId: source.templateId, title: source.title, period: source.period, scope: source.scope };
    guard = {
      kind: 'recorded', template: source.templateId, period: source.period, scope: source.scope,
      proposals: state.proposals.filter(row => row.template_id === source.templateId && row.period_start === source.period && row.scope_key === source.scope),
      rooms: source.scope.startsWith('room:') ? state.rooms.filter(row => `room:${row.room}` === source.scope && row.period_start === source.period) : [],
    };
    const room = source.scope.match(/^room:(\d{2,4})$/)?.[1];
    if (room) {
      const location = await admin.from('locations').select('name,room_number').eq('hotel_id', HOTEL_ID).eq('id', candidate.locationId).eq('active', true).maybeSingle();
      if (location.error) throw new PmSubmissionError('The recorded room location could not be verified.', 503);
      if (!location.data || (String(location.data.room_number || '').trim() !== room && location.data.name?.match(/\b\d{2,4}\b/)?.[0] !== room)) {
        throw new PmSubmissionError("Select the recorded room's location; the historical room cannot be reassigned.", 400);
      }
    }
  } else {
    if (typeof input.proposalId !== 'string' || !isUuid(input.proposalId)) throw new PmSubmissionError('A saved PM proposal is required.', 400);
    const result = await admin.from('cmpri_pm_proposals').select('id,template_id,period_start,scope_key,payload,revision,status,submitted_by')
      .eq('hotel_id', HOTEL_ID).eq('id', input.proposalId).maybeSingle();
    if (result.error) throw new PmSubmissionError('The saved PM issue could not be verified.', 503);
    const record = result.data;
    if (!record || record.submitted_by !== actorId || record.status !== 'pending' || Number(record.revision) !== input.revision) {
      throw new PmSubmissionError('The PM record changed or is no longer your editable proposal. Reopen it before confirming.');
    }
    const { template, mixed } = recordedTemplate(record.template_id, record.payload?.responses);
    if (mixed) throw new PmSubmissionError('This saved inspection mixes checklist versions. Reconcile its answer identities before confirming.');
    const issue = template && pmIssueCandidates(template, record.payload).find(item => item.key === input.issueKey);
    if (!template || !issue || !issue.detail.trim() || !isUuid(issue.locationId)) throw new PmSubmissionError('Save the flagged item, issue description and location before confirming.', 400);
    candidate = issue;
    guard = { kind: 'proposal', record };
    context = { templateId: template.id, title: template.title, period: record.period_start, scope: record.scope_key };
  }
  const externalId = pmIssueExternalId(context.templateId, context.period, context.scope, candidate.key);
  const prior = await admin.from('work_orders').select('id,display_id,status').eq('hotel_id', HOTEL_ID).eq('import_source', 'PM Log').eq('import_external_id', externalId).maybeSingle();
  if (prior.error) throw new PmSubmissionError('The PM issue link could not be checked.', 503);
  return {
    externalId, guard, existing: prior.data,
    order: { location_id: candidate.locationId, issue: `PM: ${candidate.label}`,
      notes: `PM form: ${context.title}\nPeriod: ${context.period}\nScope: ${context.scope}\nItem: ${candidate.label}\nIssue: ${candidate.detail}` },
  };
}
