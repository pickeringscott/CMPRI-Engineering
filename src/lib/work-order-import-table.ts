/** Shared native import-table parser used by the page and original-file Ask adapter. */
export type ImportRow = { external_id?: string; location?: string; issue?: string; notes?: string; status?: string; category?: string; priority?: string; reported_at?: string };

function parseCsvLine(line: string, delimiter: string) {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { values.push(value.trim()); value = ""; }
    else value += char;
  }
  values.push(value.trim());
  return values;
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function fieldForHeader(header: string): keyof ImportRow | null {
  const value = normalizeHeader(header);
  if (["id", "source id", "external id", "safetyculture id", "ticket id", "issue id"].includes(value)) return "external_id";
  if (["room", "room number", "location", "room location", "area"].includes(value)) return "location";
  if (["issue", "issue description", "description", "problem", "work order", "work order issue"].includes(value)) return "issue";
  if (["notes", "note", "comments", "comment", "details"].includes(value)) return "notes";
  if (["status", "state"].includes(value)) return "status";
  if (["category", "trade"].includes(value)) return "category";
  if (["priority", "severity"].includes(value)) return "priority";
  if (["reported at", "created at", "created", "date", "reported date", "date reported"].includes(value)) return "reported_at";
  return null;
}

export function parseWorkOrderImportTable(raw: string): ImportRow[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const headers = parseCsvLine(lines[0], delimiter).map(fieldForHeader);
  if (!headers.includes("location") || !headers.includes("issue")) return [];
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line, delimiter);
    const row: ImportRow = {};
    headers.forEach((field, index) => { if (field && values[index] !== undefined) row[field] = values[index]; });
    return row;
  }).filter((row) => row.location?.trim() && row.issue?.trim());
}
