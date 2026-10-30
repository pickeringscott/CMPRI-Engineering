type PmReferenceTemplate = {
  kind: string;
  sourceFile: string;
};

export function findReferencedPmTemplate<T extends PmReferenceTemplate>(
  reference: string | null | undefined,
  templates: readonly T[],
): T | null {
  if (!reference) return null;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedReference = normalize(reference);
  return templates.find((template) =>
    template.kind !== "routine" && normalizedReference.includes(normalize(template.sourceFile)),
  ) || null;
}
