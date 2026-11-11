type SummaryTicket = {
  id: string;
  revision: number;
  notes?: string | null;
  issue?: string | null;
  location_id?: string | null;
  asset_id?: string | null;
  category?: string | null;
  priority?: string | null;
  technician_name?: string | null;
  status?: string | null;
  action_root_cause?: string | null;
  parts?: string | null;
  cost?: string | number | null;
  hours?: string | number | null;
  due_by?: string | null;
  ranker_base_priority?: string | null;
  ranker_auto_urgent?: boolean | null;
};

/** Rebase a local draft only when the confirmed server change is an append to notes. */
export function canReconcileChecklistSummary(previous: SummaryTicket, fresh: SummaryTicket, localNotes: string) {
  const fields: (keyof SummaryTicket)[] = ['issue', 'location_id', 'asset_id', 'category', 'priority', 'technician_name', 'status', 'action_root_cause', 'parts', 'cost', 'hours', 'due_by', 'ranker_base_priority', 'ranker_auto_urgent'];
  return previous.id === fresh.id && Number.isSafeInteger(fresh.revision) && fresh.revision >= previous.revision
    && fields.every(field => String(fresh[field] ?? '') === String(previous[field] ?? ''))
    && String(fresh.notes || '').startsWith(String(previous.notes || '')) && localNotes === (previous.notes || '');
}
