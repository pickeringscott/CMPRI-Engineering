type RoutineChecklistItem = { id: string };

/** Summary attestations are independent evidence, never additional task completions. */
export function isPmRoutineSummary(itemId: string): boolean {
  return itemId === 'daily-21' || itemId.endsWith(':rollup');
}

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

  return {
    ...Object.fromEntries(ids.filter(id => typeof currentResponses[id] === 'boolean')
      .map(id => [id, currentResponses[id] as boolean])),
    [itemId]: checked,
  };
}

/** Shared by the visible monthly checkbox and its completion counter. */
export function pmRoutineChecked(proposal: {status?:string;responses?:Record<string,unknown>;unverified_completion_items?:readonly string[]} | undefined, itemId:string, spreadsheetSyncEnabled:boolean, sourceChecked:boolean):boolean {
  // Preserve the legacy stored check, but do not count it as verified completion.
  // Independent current workbook evidence can still establish completion.
  if (proposal?.unverified_completion_items?.includes(itemId) && !sourceChecked) return false;
  if ((proposal?.status === 'pending' || !spreadsheetSyncEnabled) && Object.hasOwn(proposal?.responses || {}, itemId)) return proposal?.responses?.[itemId] === true;
  return sourceChecked;
}
