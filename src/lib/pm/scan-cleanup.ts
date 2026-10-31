/** Only the machine-generated citation prefix is documentary. Keep the rest,
 * including uncertainty, contradictions, missing dates and maintenance notes. */
export function withoutScanCitations(text: string): string {
  return text.replace(/PM Scan\.pdf page \d+; source period: /g, 'Recorded period: ')
    .replace(/PM Scan\.pdf p\d+, pm-source-p\d+-r\d+\. /g, '')
    .replace(/PM Scan\.pdf p\d+ /g, '');
}

/** No database writes. Preserve answers, links, operational confirmations and flags. */
export function cleanScanPayload(value: unknown): Record<string, unknown> {
  const payload = JSON.parse(JSON.stringify(value && typeof value === 'object' ? value : {})) as Record<string, unknown>;
  if (payload.historical_source_import && typeof payload.historical_source_import === 'object') {
    const metadata = payload.historical_source_import as Record<string, unknown>;
    delete metadata.source_id;
    delete metadata.pages;
    if (typeof payload.notes === 'string') payload.notes = withoutScanCitations(payload.notes);
    const data = payload.form_data as {logEntries?: Array<Record<string, unknown>>} | undefined;
    for (const row of data?.logEntries || []) {
      if (typeof row.notes === 'string') row.notes = withoutScanCitations(row.notes);
    }
  }
  return payload;
}

/** Stable serialization lets review bind operational contents, not JSON key order. */
export function operationalPayload(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, sort(v)])) : item;
  return JSON.stringify(sort(cleanScanPayload(value)));
}

export function cleanScanHistory<T extends {source_name: string; source_reference: string; item_answers?: Record<string, {value: string; sourcePage?: number; evidence: string}>}>(row: T): T {
  if (!row.source_reference.includes('libfile_5860e1ae41fc81919da5f84ec1cf2ce4')) return row;
  const result = JSON.parse(JSON.stringify(row)) as T;
  result.source_name = 'Confirmed maintenance history';
  result.source_reference = row.source_reference.replace(/;?\s*scan libfile_5860e1ae41fc81919da5f84ec1cf2ce4/g, '');
  for (const answer of Object.values(result.item_answers || {})) {
    delete answer.sourcePage;
    answer.evidence = withoutScanCitations(answer.evidence);
  }
  return result;
}
