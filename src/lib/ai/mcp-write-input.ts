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

function isFeedbackRoute(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    && value.length <= 500 && !/[\r\n]/.test(value);
}

export function normalizeMcpFeedbackInput(input: Record<string, unknown>) {
  const rawType = input.feedback_type ?? input.type;
  const feedbackType = typeof rawType === "string"
    ? FEEDBACK_TYPES.find((candidate) => candidate.toLowerCase() === rawType.trim().toLowerCase())
    : undefined;
  const route = [input.page_route, input.originating_page, input.route]
    .find(isFeedbackRoute) ?? "/mcp";
  return {
    ...input,
    ...(feedbackType ? { feedback_type: feedbackType } : {}),
    page_route: route,
  };
}
