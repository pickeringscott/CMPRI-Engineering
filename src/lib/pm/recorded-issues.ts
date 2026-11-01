import { createHash } from 'node:crypto';
import type { PmTemplate } from './catalog';
import { pmIssueCandidates, pmIssueExternalId, type PmIssue } from './issues';

export type RecordedIssueSource = {
  kind: 'proposal' | 'room'; id: string; templateId: string; title: string;
  period: string; scope: string; fingerprint: string; issues: PmIssue[];
  notes: string; hold: string;
};
export function recordedFingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, canonical(item)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function recordedProposal(template: PmTemplate, record: Record<string, unknown>, userId: string): RecordedIssueSource {
  const payload = (record.payload || {}) as Record<string, unknown>;
  return {
    kind: 'proposal', id: String(record.id), templateId: template.id, title: template.title,
    period: String(record.period_start), scope: String(record.scope_key), fingerprint: recordedFingerprint(record),
    issues: pmIssueCandidates(template, payload),
    notes: [payload.notes, payload.deficiency_notes, Array.isArray((payload.form_data as Record<string, unknown> | undefined)?.logEntries) ? `Recorded log values (unchanged): ${JSON.stringify((payload.form_data as Record<string, unknown>).logEntries)}` : ''].filter(v => typeof v === 'string' && v).join('\n'),
    hold: record.status === 'approved' || (record.status === 'pending' && record.submitted_by === userId)
      ? payload.work_order_id ? 'This inspection already has a legacy work-order link. Its item mapping must be reconciled before creating another order.' : ''
      : 'This record is not approved or your own pending proposal. Its review/ownership restrictions still apply.',
  };
}
export function recordedRoom(template: PmTemplate, record: Record<string, unknown>): RecordedIssueSource {
  const answers = (record.item_answers || {}) as Record<string, {value?: string}>;
  return {
    kind: 'room', id: JSON.stringify([record.room, record.period_start]), templateId: template.id, title: `Room ${record.room} — ${template.title}`,
    period: String(record.period_start), scope: `room:${record.room}`, fingerprint: recordedFingerprint(record),
    issues: pmIssueCandidates(template, { responses: Object.fromEntries(Object.entries(answers).map(([key, answer]) => [key, answer.value])) }),
    notes: 'Recorded room answers are retained unchanged. Completion alone does not mean each item passed.', hold: '',
  };
}
/** Do not silently pick between conflicting versions of the same inspection. */
export function guardRecordedOverlaps(sources: RecordedIssueSource[]): RecordedIssueSource[] {
  const owners = new Map<string, RecordedIssueSource[]>();
  for (const source of sources) for (const issue of source.issues) {
    const key = pmIssueExternalId(source.templateId, source.period, source.scope, issue.key);
    owners.set(key, [...(owners.get(key) || []), source]);
  }
  for (const matching of owners.values()) if (matching.length > 1) {
    for (const source of matching) source.hold ||= 'Overlapping saved records describe this issue. Reconcile the source record before creating a ticket; no history has been changed.';
  }
  return sources;
}
export function reviewedRecordedIssue(source: RecordedIssueSource, input: Record<string, unknown>): PmIssue {
  if (source.hold) throw new Error(source.hold);
  if (input.fingerprint !== source.fingerprint) throw new Error('The recorded inspection changed. Reload and review it again.');
  const issue = source.issues.find(item => item.key === input.issueKey);
  if (!issue) throw new Error('The recorded issue is no longer available.');
  if (typeof input.detail !== 'string' || !input.detail.trim() || input.detail.length > 10000) throw new Error('Provide the issue description (at most 10,000 characters).');
  if (typeof input.locationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.locationId)) throw new Error('Select the issue location.');
  // Supplemental ticket details are deliberately not saved back onto the inspection.
  return { ...issue, detail: input.detail.trim(), locationId: input.locationId };
}
