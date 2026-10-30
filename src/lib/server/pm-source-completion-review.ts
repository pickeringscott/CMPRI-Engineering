import 'server-only';
import { createHash } from 'node:crypto';
import review from './pm-source-completion-review.json';

/** Exact reviewed historical evidence only. New/manual edits never inherit a verdict.
 * Completion means the source inspection was recorded, not that equipment passed.
 * No stored response is changed by this projection.
 */
export function sourceCompletionReview(proposal: {id:string;template_id:string;period_start:string;scope_key:string;payload:unknown}) {
 const verdict=review.rows.find(r=>r.id===proposal.id&&r.template_id===proposal.template_id
  &&r.period_start===proposal.period_start&&r.scope_key===proposal.scope_key);
 if(!verdict||createHash('sha256').update(JSON.stringify(proposal.payload)).digest('hex')!==verdict.payload_sha256)return null;
 return verdict;
}
