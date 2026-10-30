/** Merge sparse approved routine edits without allowing another draft to erase them.
 * Callers must supply records already restricted to the authorized property/period.
 */
export type RoutineProposal = {
  template_id: string; period_start: string; scope_key: string;
  status: string; updated_at?: string | null; id?: string;
  payload?: unknown;
};

export function approvedRoutineResponses(proposals: readonly RoutineProposal[]) {
  const result = new Map<string, Record<string, unknown>>();
  const approved = proposals.filter(p => p.status === 'approved' && p.template_id.startsWith('workbook:'))
    .slice().sort((a,b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')) || String(a.id || '').localeCompare(String(b.id || '')));
  for (const proposal of approved) {
    const payload = proposal.payload && typeof proposal.payload === 'object' ? proposal.payload as Record<string, unknown> : {};
    const responses = payload.responses;
    if (!responses || typeof responses !== 'object' || Array.isArray(responses)) continue;
    const key = `${proposal.template_id}|${proposal.period_start}|${proposal.scope_key}`;
    result.set(key, { ...result.get(key), ...responses });
  }
  return result;
}

/** Track uncertainty per response, so an unrelated sparse edit cannot erase it. */
export function approvedRoutineUnverifiedItems<T extends RoutineProposal>(
  proposals: readonly T[], review: (proposal: T) => { unverified_items: string[] } | null,
) {
  const result = new Map<string, Set<string>>();
  const approved = proposals.filter(p => p.status === 'approved' && p.template_id.startsWith('workbook:'))
    .slice().sort((a,b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')) || String(a.id || '').localeCompare(String(b.id || '')));
  for (const proposal of approved) {
    const payload = proposal.payload && typeof proposal.payload === 'object' ? proposal.payload as Record<string, unknown> : {};
    if (!payload.responses || typeof payload.responses !== 'object' || Array.isArray(payload.responses)) continue;
    const key = `${proposal.template_id}|${proposal.period_start}|${proposal.scope_key}`;
    const flags = result.get(key) || new Set<string>();
    const uncertain = new Set(review(proposal)?.unverified_items || []);
    for (const item of Object.keys(payload.responses)) {
      if (uncertain.has(item)) flags.add(item);
      else flags.delete(item);
    }
    result.set(key, flags);
  }
  return result;
}
