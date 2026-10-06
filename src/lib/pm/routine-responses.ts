type RoutineChecklistItem = { id: string };

export function isPmRoutineCellChecked(targets: readonly { value: string }[]): boolean {
  return targets[0]?.value === "TRUE";
}

export function togglePmRoutineResponse(
  checklist: readonly RoutineChecklistItem[],
  currentResponses: Readonly<Record<string, unknown>>,
  itemId: string,
  checked: boolean,
): Record<string, boolean> {
  const ids = checklist.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("PM routine checklist item IDs must be unique.");
  }
  if (!ids.includes(itemId)) {
    throw new Error("The PM routine checklist item is not available.");
  }

  return Object.fromEntries(ids.map((id) => [
    id,
    id === itemId ? checked : currentResponses[id] === true,
  ]));
}
