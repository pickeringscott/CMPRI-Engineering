import type { PmFormField } from "./catalog";

// Presentation only: every source field stays in exactly one group, with its ID intact.
export function pmFieldGroups(fields: PmFormField[]) {
  const groups = [
    { title: "Location and identification", fields: [] as PmFormField[] },
    { title: "Inspection dates", fields: [] as PmFormField[] },
    { title: "Form details and observations", fields: [] as PmFormField[] },
  ];
  for (const field of fields) {
    const index = field.type === "date" ? 1
      : /location|identifier|inspectedBy|room|equipment|serial/i.test(field.id) ? 0 : 2;
    groups[index].fields.push(field);
  }
  return groups.filter(group => group.fields.length);
}

export function pmRecordSummary(fields: PmFormField[], row: Record<string, string>, index: number) {
  const populated = fields.filter(field => field.type !== "textarea" && String(row[field.id] ?? "").trim());
  // Keep result labels, including NO/failed and zero quantities, without inferring a verdict.
  return populated.length
    ? populated.map(field => `${field.label}: ${row[field.id]}`).join(" · ")
    : `Record ${index + 1} — no details entered`;
}
