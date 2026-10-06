type PmReferenceTemplate = {
  kind: string;
  sourceFile: string;
};

export function findReferencedPmTemplate<T extends PmReferenceTemplate>(
  reference: string | null | undefined,
  templates: readonly T[],
): T | null {
  if (!reference) return null;
  const normalizedReference = reference.toLowerCase();
  return templates.find((template) =>
    template.kind !== "routine" && normalizedReference.includes(template.sourceFile.toLowerCase()),
  ) || null;
}
