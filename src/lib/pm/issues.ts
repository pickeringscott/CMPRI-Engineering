import type { PmTemplate } from "./catalog";

export type PmIssue = { key: string; label: string; detail: string; locationId: string };
export type PmIssueLink = { id: string; display_id?: string; import_external_id: string; status?: string };
/** Only a persisted ticket link establishes submitted attention, regardless of repair status. */
export function pmSubmittedIssueLinks(links: PmIssueLink[], templateId: string, period: string, scope: string, key?: string) {
  const identity = key === undefined ? pmIssueContext(templateId, period, scope) : pmIssueExternalId(templateId, period, scope, key);
  return links.filter(link => !!link.id && (key === undefined ? link.import_external_id.startsWith(identity) : link.import_external_id === identity));
}
export function pmTicketClosed(link: { status?: string } | undefined) {
  return link?.status === "Closed";
}
type Payload = { responses?: Record<string, unknown>; form_data?: Record<string, unknown>; deficiency_notes?: string };
export function validatePmIssueMetadata(data: Record<string, unknown>): string | null {
  const details = data.pmIssueDetails;
  if (details !== undefined) {
    if (!details || typeof details !== "object" || Array.isArray(details) || Object.keys(details).length > 2000) return "Invalid PM issue details.";
    for (const [key, value] of Object.entries(details)) {
      if (key.length > 180 || !value || typeof value !== "object" || Array.isArray(value)) return "Invalid PM issue detail.";
      const item = value as Record<string, unknown>;
      if (item.detail !== undefined && (typeof item.detail !== "string" || item.detail.length > 10000)) return "PM issue descriptions must be at most 10,000 characters.";
      if (item.locationId !== undefined && (typeof item.locationId !== "string" || (item.locationId !== "" && !/^[0-9a-f-]{36}$/i.test(item.locationId)))) return "Select a valid PM issue location.";
      if (item.flagged !== undefined && typeof item.flagged !== "boolean") return "Invalid PM issue flag.";
    }
  }
  if (Array.isArray(data.logEntries)) {
    const ids = new Set<string>();
    for (const row of data.logEntries) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return "Invalid PM inspection row.";
      const id = row._pmRowId;
      if (id === undefined) continue; // Unchanged legacy rows remain readable/saveable.
      if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || ids.has(id)) return "Inspection row identities must be unique.";
      ids.add(id);
    }
  }
  return null;
}
/** Condition semantics, not a blanket interpretation of NO or an unchecked box. */
const NO_IS_ISSUE = new Set(["functional", "passed", "clearAccess", "locked", "allEmployeesAccountedFor"]);
export function pmIssueCandidates(template: PmTemplate, payload: Payload): PmIssue[] {
  const data = payload.form_data || {};
  const details = data.pmIssueDetails && typeof data.pmIssueDetails === "object" && !Array.isArray(data.pmIssueDetails)
    ? data.pmIssueDetails as Record<string, { detail?: string; locationId?: string; flagged?: boolean }> : {};
  const result: PmIssue[] = [];
  const add = (key: string, label: string, automatic: boolean) => {
    const saved = details[key];
    if (!automatic && saved?.flagged !== true) return;
    result.push({ key, label, detail: typeof saved?.detail === "string" ? saved.detail : "", locationId: typeof saved?.locationId === "string" ? saved.locationId : "" });
  };
  for (const item of template.checklist) add(`item:${item.id}`, item.label, payload.responses?.[item.id] === "follow-up");
  for (const field of template.fields) add(`field:${field.id}`, field.label, NO_IS_ISSUE.has(field.id) && String(data[field.id]).toUpperCase() === "NO");
  const rows = Array.isArray(data.logEntries) ? data.logEntries as Record<string, unknown>[] : [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    // Persisted row identity survives removal/reordering. Legacy rows acquire one on opening.
    const rowId = typeof row._pmRowId === "string" ? row._pmRowId : `legacy-${index}`;
    for (const field of template.repeatableFields || []) {
      add(`row:${rowId}:${field.id}`, `${String(row.location || row.unitIdentifier || `Record ${index + 1}`)} — ${field.label}`,
        (NO_IS_ISSUE.has(field.id) && String(row[field.id]).toUpperCase() === "NO") || (field.id === "position" && row[field.id] === "Shut"));
    }
  });
  add("notes:follow-up", "Recorded follow-up", false);
  return result;
}

export function pmIssueContext(templateId: string, period: string, scope: string) {
  return `pm:${encodeURIComponent(JSON.stringify([templateId, period, scope]))}:`;
}
export function pmIssueExternalId(templateId: string, period: string, scope: string, key: string) {
  return pmIssueContext(templateId, period, scope) + encodeURIComponent(key);
}
