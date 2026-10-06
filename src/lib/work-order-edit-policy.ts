import { roleKey } from "./server/roles";

export const TECHNICAL_WORK_ORDER_FIELDS = [
  "issue", "asset_id", "asset_name", "category", "priority", "technician_name", "status", "notes",
  "action_root_cause", "parts", "cost", "hours", "due_by",
] as const;

export const REVIEW_WORK_ORDER_FIELDS = ["status", "notes"] as const;
export const NOTE_ONLY_WORK_ORDER_FIELDS = ["notes"] as const;
export const ASSIGNED_TECHNICIAN_WORK_ORDER_FIELDS = ["asset_id", "category", "status", "notes"] as const;
export const UNASSIGNED_TECHNICIAN_WORK_ORDER_FIELDS = ["technician_name"] as const;

export type WorkOrderEditableField =
  | (typeof TECHNICAL_WORK_ORDER_FIELDS)[number]
  | (typeof REVIEW_WORK_ORDER_FIELDS)[number]
  | (typeof ASSIGNED_TECHNICIAN_WORK_ORDER_FIELDS)[number]
  | (typeof UNASSIGNED_TECHNICIAN_WORK_ORDER_FIELDS)[number];

export function canSubmitWorkOrderNote({
  role,
  canEdit,
  canReview,
  canAddNotes = false,
  status,
  unassigned = false,
  canClaimUnassigned = false,
}: {
  role?: unknown;
  canEdit: boolean;
  canReview: boolean;
  canAddNotes?: boolean;
  status: string | null | undefined;
  unassigned?: boolean;
  canClaimUnassigned?: boolean;
}) {
  if (roleKey(role) === "technician") {
    return workOrderEditableFields({
      role,
      canEdit,
      canReview,
      canAddNotes,
      unassigned,
      canClaimUnassigned,
    }).includes("notes");
  }
  return canEdit
    || (canAddNotes && ["Open", "In Progress"].includes(String(status || "")))
    || (canReview && status === "Pending Verification");
}

export function workOrderEditableFields({
  role,
  canEdit,
  canReview,
  canAddNotes = false,
  unassigned,
  canClaimUnassigned,
}: {
  role: unknown;
  canEdit: boolean;
  canReview: boolean;
  canAddNotes?: boolean;
  unassigned: boolean;
  canClaimUnassigned: boolean;
}): readonly WorkOrderEditableField[] {
  if (roleKey(role) === "technician") {
    if (!canEdit) return [];
    if (unassigned) return canClaimUnassigned ? UNASSIGNED_TECHNICIAN_WORK_ORDER_FIELDS : [];
    return ASSIGNED_TECHNICIAN_WORK_ORDER_FIELDS;
  }
  if (canAddNotes) return NOTE_ONLY_WORK_ORDER_FIELDS;
  if (canEdit) return TECHNICAL_WORK_ORDER_FIELDS;
  if (canReview) return REVIEW_WORK_ORDER_FIELDS;
  return [];
}
