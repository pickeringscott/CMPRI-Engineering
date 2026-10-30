export type SourceRoutineCheck = {
  template_id: string; period_start: string; scope_key: string;
  item_id: string; checked: boolean;
  source: { library_id: string; sheet: string; cell: string };
};
export type ExistingRoutineRecord = {
  id: string; template_id: string; period_start: string; scope_key: string;
  status: string; revision: number; updated_at: string;
  payload: { responses?: Record<string, unknown>; [key: string]: unknown };
};

/** Pure preview. Does not authorize, persist, or overwrite any user response.
 * The eventual transaction must compare the complete expected record set again.
 * FALSE in an older workbook means no positive completion evidence, not a reset.
 */
export function planSourceRoutineChecks(source: readonly SourceRoutineCheck[], existing: readonly ExistingRoutineRecord[]) {
  const additions: SourceRoutineCheck[] = [];
  const alreadyRecorded: SourceRoutineCheck[] = [];
  const conflicts: { check: SourceRoutineCheck; recordIds: string[]; reason: string }[] = [];
  const unmarked: SourceRoutineCheck[] = [];
  const seen = new Map<string, SourceRoutineCheck>();
  for (const check of source) {
    const key = `${check.template_id}|${check.period_start}|${check.scope_key}|${check.item_id}`;
    const prior = seen.get(key);
    if (prior) {
      if (prior.checked !== check.checked) conflicts.push({check,recordIds:[],reason:'Conflicting source cells target the same task.'});
      continue;
    }
    seen.set(key, check);
    if (!check.checked) { unmarked.push(check); continue; }
    const records = existing.filter(record => record.status !== 'rejected'
      && record.template_id === check.template_id && record.period_start === check.period_start
      && record.scope_key === check.scope_key);
    const answers = records.filter(record => Object.hasOwn(record.payload.responses || {}, check.item_id));
    if (answers.some(record => record.payload.responses?.[check.item_id] !== true)) {
      conflicts.push({check,recordIds:answers.map(record=>record.id),reason:'Existing response differs; preserve it for explicit reconciliation.'});
    } else if (answers.some(record=>record.status === 'approved')) {
      alreadyRecorded.push(check);
    } else if (answers.length) {
      conflicts.push({check,recordIds:answers.map(record=>record.id),reason:'A pending review owns this task; do not silently approve or supersede it.'});
    } else additions.push(check);
  }
  // A preview carrying any conflict cannot be applied as an apparently complete batch.
  return { additions, alreadyRecorded, conflicts, unmarked, canApply: conflicts.length === 0,
    expectedRecords: existing };
}
