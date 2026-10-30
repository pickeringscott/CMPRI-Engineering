import { findReferencedPmTemplate } from './references';
import type { PmTemplate } from './catalog';

export type CompletionEntry = {
  template_id:string; period_start:string; scope_key:string; status?:string;
  is_complete?:boolean; historical_source_import?:unknown; source_completion_verified?:boolean;
};

/** Legacy source imports were marked complete merely for having an answer.
 * Only the server-projected, exact-evidence review can verify these imports.
 * A source row alone is not that review; failed conditions remain unchanged.
 */
export function verifiedInspectionCompletion(entry: Pick<CompletionEntry, 'is_complete' | 'historical_source_import' | 'source_completion_verified'>): boolean {
  return entry.is_complete === true && (!entry.historical_source_import || entry.source_completion_verified === true);
}

/** Explicit reviewer-approved property-wide inspection completion, never condition inference. */
export function linkedRoutineCompletion(reference:string, period:string, templates:readonly PmTemplate[], entries:readonly CompletionEntry[]):boolean {
  const names = reference.split(/[,\n]/).filter(part=>/\.pdf/i.test(part));
  if (!names.length) return false;
  const forms=names.map(name=>findReferencedPmTemplate(name,templates));
  if (forms.some(form=>!form)) return false;
  return forms.every(form=>entries.some(entry=>{
    if (!form || entry.template_id!==form.id || entry.status!=='approved' || !verifiedInspectionCompletion(entry)) return false;
    if (!['property','area:property','equipment:property wide'].includes(entry.scope_key)) return false;
    if (form.cadence!=='quarterly') return entry.period_start===period;
    return entry.period_start.slice(0,4)===period.slice(0,4)
      && Math.floor((Number(entry.period_start.slice(5,7))-1)/3)===Math.floor((Number(period.slice(5,7))-1)/3);
  }));
}
