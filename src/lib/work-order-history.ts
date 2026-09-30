export type WorkOrderHistoryEvent = {
  event_type?: string | null;
  old_status?: string | null;
  new_status?: string | null;
  changed_fields?: Record<string, unknown> | null;
  actor_name?: string | null;
  source?: string | null;
};

function field(event: WorkOrderHistoryEvent, key: string) {
  const value = event.changed_fields?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/** One-line ticket-history text: what changed, plus when (time of day) and how (channel). */
export function workOrderHistoryText(event: WorkOrderHistoryEvent, recordedAt?: string | null) {
  const details: string[] = [workOrderHistoryAction(event)];
  const when = recordedAt ? new Date(recordedAt) : null;
  if (when && !Number.isNaN(when.getTime())) {
    details.push(when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  }
  const source = event.source?.trim();
  if (source) details.push(`via ${source}`);
  return details.join(" · ");
}

export function workOrderHistoryAction(event: WorkOrderHistoryEvent) {
  const technician = field(event, "technician_name");
  const previous = field(event, "previous_technician_name");
  const statusChange = `Status ${event.old_status || "—"} → ${event.new_status || "—"}`;
  switch (event.event_type) {
    case "created": return "Work order created";
    case "claimed": {
      const claimer = technician || event.actor_name?.trim() || "a technician";
      return previous && previous !== claimer ? `Claimed by ${claimer} (was ${previous})` : `Claimed by ${claimer}`;
    }
    case "assigned": return previous ? `Reassigned from ${previous} to ${technician}` : `Assigned to ${technician}`;
    case "unassigned": return previous ? `Unassigned from ${previous}` : "Technician unassigned";
    case "closed": return `Closed (${statusChange})`;
    case "reopened": return `Reopened (${statusChange})`;
    case "status_changed": return statusChange;
    default: {
      if (event.old_status && event.new_status && event.old_status !== event.new_status) return statusChange;
      return String(event.event_type || "Work order updated").replace(/_/g, " ");
    }
  }
}
