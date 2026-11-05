import type { PmTaskState } from './task-review';
type Reference = { id: string; kind: string; cadence: string; sourceFile: string; checklist: Array<{ id: string; source?: string }> };
/** The task ledger is the durable review record; retain every original form field. */
export function projectLinkedFormReviews(entries: Record<string, unknown>[], templates: readonly Reference[]) {
  const reviews = new Map<string, PmTaskState>();
  for (const entry of entries) {
    const routine = templates.find(template => template.id === entry.template_id);
    if (routine?.kind !== 'routine' || routine.cadence !== 'weekly' || !entry.task_states) continue;
    const states = entry.task_states as Record<string, PmTaskState>;
    for (const item of routine.checklist) {
      const state = states[item.id];
      const form = item.source ? templates.find(candidate => candidate.kind !== 'routine' && item.source!.toLowerCase().includes(candidate.sourceFile.toLowerCase())) : undefined;
      if (form && state?.attachedFormStatus) reviews.set(`${form.id}|${entry.period_start}`, state);
    }
  }
  return entries.map(entry => {
    const review = reviews.get(`${entry.template_id}|${entry.period_start}`);
    // These are the property-level attached drafts opened from weekly checklist rows.
    if (!review || !['property', 'area:property'].includes(String(entry.scope_key))) return entry;
    return { ...entry, is_complete: review.attachedFormStatus === 'final', linked_task_review: review.attachedFormStatus,
      completed_by_name: review.workerName || entry.completed_by_name };
  });
}
