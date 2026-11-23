import "server-only";
import type { AskResultItem } from "@/lib/ask-cmpri/types";
import { askPmPace, askPmPlanningSummary, askPmWindow, buildAskPmPlanning, latestAskPmEntries, type AskPmOptions, type AskPmPlanning } from "@/lib/ask-cmpri/pm-planning";
import { HOTEL_ID } from "@/lib/constants";
import { PM_ROOM_NUMBERS, PM_TEMPLATES } from "@/lib/pm/catalog";
import { projectLinkedFormReviews } from "@/lib/pm/linked-form-review";
import { allows, type Principal } from "@/lib/server/access";
import type { AuthAttempt } from "@/lib/server/auth";
import { fetchAllPages } from "@/lib/server/paginated-query";

type Authorized = Extract<AuthAttempt, { ok: true }>;
type Row = Record<string, unknown>;
export type AskPmRead = { items: AskResultItem[]; summary: string; planning?: AskPmPlanning; missing?: string };

export function canReadAskPm(principal: Principal) {
  return allows(principal, "view_pm");
}

function unavailable(message: string): AskPmRead {
  return { items: [], summary: message, missing: message };
}

function pmItem(id: string, title: string, text: string, facts: { label: string; value: string }[]): AskResultItem {
  return { id: "preventiveMaintenance:" + id, title, text, source: "CMPRI · Preventive Maintenance", sourceType: "internal",
    href: "/engineering/preventive-maintenance", hrefLabel: "Open Preventive Maintenance", facts };
}

/** Native PM role gate and records; no spreadsheet, work-order, or sampled-row totals. */
export async function readAskPm(auth: Authorized, options: AskPmOptions = {}): Promise<AskPmRead> {
  if (!canReadAskPm(auth.principal)) return unavailable("Preventive Maintenance is outside this account's current role permissions.");
  let window;
  try { window = askPmWindow(options); }
  catch (error) { return unavailable(error instanceof Error ? error.message : "The PM date range is invalid."); }
  const requested = [...new Set((options.rooms || []).map(room => room.trim().replace(/^(?:room|rm|habitaci[oó]n|cuarto)\s*#?\s*/i, "")))];
  const invalid = requested.filter(room => !PM_ROOM_NUMBERS.includes(room));
  if (invalid.length) return unavailable(`The PM room register does not contain ${invalid.map(room => "Room " + room).join(", ")}.`);
  const rooms = requested.length ? requested : [...PM_ROOM_NUMBERS];
  try {
    const [proposals, history] = await Promise.all([
      fetchAllPages<Row>((from, to) => {
        let query = auth.admin.from("cmpri_pm_proposals")
          .select("id,template_id,period_start,scope_key,payload,status,submitted_by,updated_at")
          .eq("hotel_id", HOTEL_ID).neq("status", "rejected")
          .gte("period_start", window.readFrom).lte("period_start", window.toDate);
        // Routine/form rows remain necessary to explain other PM workload even for a room query.
        query = query.order("id");
        return query.range(from, to);
      }),
      fetchAllPages<Row>((from, to) => {
        let query = auth.admin.from("cmpri_room_pm_history")
          .select("room,period_start,completed_on").eq("hotel_id", HOTEL_ID)
          .gte("period_start", window.readFrom).lte("period_start", window.toDate);
        if (requested.length) query = query.in("room", rooms);
        return query.order("room").order("period_start").range(from, to);
      }),
    ]);
    if (proposals.error || history.error) return unavailable("CMPRI PM records could not be fully read. Remaining counts and daily targets are unavailable until those records load.");
    const entries = projectLinkedFormReviews(latestAskPmEntries(proposals.data || [], auth.principal.identity.id), PM_TEMPLATES);
    const planning = buildAskPmPlanning({ window, rooms, templates: PM_TEMPLATES, entries, roomHistory: history.data || [], proposalCount: (proposals.data || []).length });
    const pace = askPmPace(planning.roomPm.remaining, window);
    const facts = [
      { label: "As of", value: window.today + " · America/Chicago" },
      { label: "Planning window", value: `${window.fromDate} through ${window.toDate}` },
      { label: "Rooms", value: String(rooms.length) },
      { label: "Scheduled room-quarter PMs", value: String(planning.roomPm.scheduled) },
      { label: "Recorded complete", value: String(planning.roomPm.complete) },
      { label: "Remaining", value: String(planning.roomPm.remaining) },
      { label: "Complete, awaiting review", value: String(planning.roomPm.awaitingReview) },
      { label: "Calendar days remaining", value: String(window.calendarDays) },
      { label: "Monday–Friday weekdays remaining", value: String(window.weekdays) },
      { label: "Calendar-day target", value: pace.calendarTarget === null ? "Deadline has passed" : `${pace.calendarTarget} room PMs/day (${pace.calendarAverage!.toFixed(2)} average)` },
      { label: "Weekday target", value: pace.weekdayTarget === null ? "No weekdays remaining" : `${pace.weekdayTarget} room PMs/weekday (${pace.weekdayAverage!.toFixed(2)} average)` },
      { label: "Counting basis", value: "One PM per room per scheduled quarter. Completion follows native PM records; pending review is separate. Current proposals take precedence over historical copies." },
    ];
    const items = [pmItem("room-plan", "Guest-room PM completion plan", askPmPlanningSummary(planning), facts)];
    for (const period of planning.roomPeriods) items.push(pmItem("rooms-" + period.period, `Guest-room PM · quarter starting ${period.period}`,
      `${period.remaining} room PMs remaining; ${period.complete} recorded complete out of ${period.scheduled}.`, [
        { label: "Period", value: period.period }, { label: "Remaining", value: String(period.remaining) },
        { label: "Remaining rooms", value: period.remainingRooms.join(", ") || "None" },
        { label: "Completed rooms", value: period.completedRooms.join(", ") || "None" },
      ]));
    if (planning.priorRoomPm.scheduled) items.push(pmItem("prior-room-backlog", "Earlier room-quarter completion records",
      `${planning.priorRoomPm.remaining} room-quarter PMs in earlier ${window.fromDate.slice(0, 4)} quarters have no recorded completion.`,
      planning.priorRoomPeriods.map(period => ({ label: period.period, value: `${period.remaining} remaining of ${period.scheduled}; ${period.complete} recorded complete` }))));
    items.push(pmItem("routine-plan", "Routine maintenance checklist workload",
      "Routine checklist items are counted separately from guest-room PMs and inspection forms; they are not added to the room-PM daily target.",
      Object.entries(planning.routineItems.byCadence).map(([cadence, count]) => ({ label: cadence, value: `${count.remaining} checklist items remaining of ${count.scheduled}; ${count.complete} complete; ${count.awaitingReview} complete awaiting review` }))));
    items.push(pmItem("inspection-plan", "Other scheduled PM inspection forms",
      "Template-period counts describe the schedule. They do not establish how many equipment units or locations require individual forms.", [
        { label: "Scheduled template periods", value: String(planning.inspections.scheduledTemplatePeriods) },
        { label: "Periods with no completed form", value: String(planning.inspections.periodsWithoutCompletedForm) },
        { label: "Saved completed forms", value: String(planning.inspections.savedCompletedForms) },
        { label: "Saved draft forms", value: String(planning.inspections.savedDraftForms) },
        { label: "Equipment/area schedules", value: String(planning.inspections.equipmentOrAreaSchedules) },
      ]));
    return { items, planning, summary: askPmPlanningSummary(planning) };
  } catch {
    return unavailable("CMPRI PM records are unavailable. No completion counts or daily targets were inferred.");
  }
}
