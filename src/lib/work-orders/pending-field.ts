/** Compare editor drafts with the last successful saved snapshot; never mutates either. */
export function pendingTicketField(chief: boolean, saved: string, draft: string, field: string) {
  if (!chief || !saved || !draft) return false;
  const baseline: Record<string, unknown> = JSON.parse(saved);
  const current: Record<string, unknown> = JSON.parse(draft);
  if (!Object.hasOwn(baseline, field) || !Object.hasOwn(current, field)) return false;
  const normalize = (value: unknown) => {
    const text = String(value ?? "").trim();
    if ((field === "hours" || field === "cost") && text !== "" && Number.isFinite(Number(text))) return Number(text);
    return text;
  };
  return normalize(baseline[field]) !== normalize(current[field]);
}
