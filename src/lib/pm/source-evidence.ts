export type PmSourcePage = {
  page: number;
  templateId: string | null;
  category: string;
  location: string;
  frequency: string;
  kind: "blank-template" | "observations" | "room-history-reference";
  rawDate: string;
  observedOn: string | null;
  evidence: string;
  findings: string[];
  unresolved: string[];
};
export type PmSourceImport = { sourceId: string; sourceName: string; pageCount: number; pages: PmSourcePage[] };

function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number, optional = false) {
  if (typeof value !== "string" || value.length > max || (!optional && !value.trim())) throw new Error(`${label} is required and must be at most ${max} characters.`);
  return value.trim();
}
function list(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > 200) throw new Error(`${label} must be an array of at most 200 observations.`);
  return value.map(item => text(item, label, 4000));
}
// Source evidence is deliberately separate from completion and checklist answers.
// An observed date, printed tag date, or checked YES cannot imply completion.
export function validatePmSource(value: unknown, templateIds: readonly string[]): PmSourceImport {
  const input = obj(value);
  const sourceId = text(input.sourceId, "Source ID", 160);
  const sourceName = text(input.sourceName, "Source name", 300);
  const pageCount = input.pageCount;
  if (!Number.isSafeInteger(pageCount) || Number(pageCount) < 1 || Number(pageCount) > 1000) throw new Error("Provide the actual source page count (1-1000).");
  if (!Array.isArray(input.pages) || input.pages.length !== pageCount) throw new Error("Account for every source page exactly once.");
  const seen = new Set<number>();
  const pages = input.pages.map((value): PmSourcePage => {
    const row = obj(value);
    const page = Number(row.page);
    if (!Number.isSafeInteger(row.page) || page < 1 || page > Number(pageCount) || seen.has(page)) throw new Error("Source page numbers must be unique and cover the whole document.");
    seen.add(page);
    const templateId = row.templateId;
    if (templateId !== null && (typeof templateId !== "string" || !templateIds.includes(templateId))) throw new Error(`Page ${page}: unknown template.`);
    if (!["blank-template", "observations", "room-history-reference"].includes(String(row.kind))) throw new Error(`Page ${page}: choose an evidence classification.`);
    const observedOn = row.observedOn;
    if (observedOn !== null) {
      if (typeof observedOn !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(observedOn)) throw new Error(`Page ${page}: use a verified full date or null.`);
      const date = new Date(`${observedOn}T12:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== observedOn) throw new Error(`Page ${page}: invalid observation date.`);
    }
    const unresolved = list(row.unresolved, "Unresolved evidence");
    if (templateId === null && !unresolved.length) throw new Error(`Page ${page}: explain the missing template match.`);
    for (const key of ["isComplete", "completedOn", "responses", "createWorkOrder"]) {
      if (Object.hasOwn(row, key)) throw new Error(`Page ${page}: source import cannot set completions, answers, or work orders.`);
    }
    return { page, templateId: templateId as string | null, category: text(row.category, "Category", 200), location: text(row.location, "Location or unknown", 300), frequency: text(row.frequency, "Frequency or unknown", 100), kind: row.kind as PmSourcePage["kind"], rawDate: text(row.rawDate, "Raw source date", 1000, true), observedOn: observedOn as string | null, evidence: text(row.evidence, "Source evidence", 20000), findings: list(row.findings, "Findings"), unresolved };
  }).sort((a, b) => a.page - b.page);
  return { sourceId, sourceName, pageCount: Number(pageCount), pages };
}
