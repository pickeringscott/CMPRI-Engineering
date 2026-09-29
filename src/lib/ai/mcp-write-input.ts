const WORK_ORDER_STATUSES = [
  "Pending Verification",
  "Open",
  "In Progress",
  "Completed",
  "Will Not Do",
  "Closed",
] as const;

const WORK_ORDER_UPDATE_FIELDS = [
  "issue",
  "asset_id",
  "asset_name",
  "category",
  "priority",
  "technician_name",
  "status",
  "notes",
  "action_root_cause",
  "parts",
  "cost",
  "hours",
  "due_by",
] as const;

export function normalizeMcpWorkOrderUpdate(input: Record<string, unknown>) {
  const nested = input.changes ?? input.updates ?? input.fields;
  if (nested !== undefined && (!nested || typeof nested !== "object" || Array.isArray(nested))) {
    throw new Error("Work-order changes must be supplied as an object.");
  }

  const changes = nested as Record<string, unknown> | undefined;
  const payload: Record<string, unknown> = { ...input, ...(changes || {}) };
  delete payload.changes;
  delete payload.updates;
  delete payload.fields;

  if (payload.technician_name === undefined) {
    for (const alias of ["assigned_technician", "assigned_to", "technician"] as const) {
      if (Object.prototype.hasOwnProperty.call(payload, alias)) {
        payload.technician_name = payload[alias];
        delete payload[alias];
        break;
      }
    }
  }

  const requestedStatus = payload.status;
  if (typeof requestedStatus === "string") {
    const status = WORK_ORDER_STATUSES.find((candidate) => candidate.toLowerCase() === requestedStatus.trim().toLowerCase());
    if (status) payload.status = status;
  }

  const writableFields = new Set<string>(WORK_ORDER_UPDATE_FIELDS);
  const hasChanges = Object.keys(payload).some((key) => writableFields.has(key));
  if (!hasChanges) {
    throw new Error("No editable work-order changes were supplied. Provide notes, status, or another editable field inside changes.");
  }
  return payload;
}

const FEEDBACK_TYPES = ["Problem", "Bug", "Suggestion"] as const;

export function normalizeMcpFeedbackInput(input: Record<string, unknown>) {
  const rawType = input.feedback_type ?? input.type;
  if (typeof rawType !== "string") return input;
  const feedbackType = FEEDBACK_TYPES.find((candidate) => candidate.toLowerCase() === rawType.trim().toLowerCase());
  return feedbackType ? { ...input, feedback_type: feedbackType } : input;
}
