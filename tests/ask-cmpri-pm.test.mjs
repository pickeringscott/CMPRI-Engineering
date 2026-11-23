import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const planning = loadTs("src/lib/ask-cmpri/pm-planning.ts", {}, { Date, Intl, Map, Set });
const template = (id, cadence, kind = "routine", scope = "property", months) => ({
  id, title: id, cadence, kind, scope, ...(months ? { months } : {}), sourceFile: id, sourceReference: id,
  checklist: [{ id: "one" }, { id: "two" }], fields: [],
});
const templates = [
  template("room", "quarterly", "room", "room", [1, 4, 7, 10]),
  template("daily", "daily"), template("weekly", "weekly"), template("monthly", "monthly"),
  template("equipment", "quarterly", "inspection", "equipment", [3, 6, 9, 12]),
];
const proposal = (id, templateId, period, scope, payload, extra = {}) => ({
  id, template_id: templateId, period_start: period, scope_key: scope, payload, status: "pending",
  submitted_by: "actor", updated_at: "2026-11-23T12:00:00Z", ...extra,
});

test("PM year-end pace uses Chicago today and counts inclusive calendar/weekday dates without DST drift", () => {
  const window = planning.askPmWindow({}, new Date("2026-11-24T02:00:00Z"));
  assert.equal(window.today, "2026-11-23");
  assert.equal(window.toDate, "2026-12-31");
  assert.equal(window.calendarDays, 39);
  assert.equal(window.weekdays, 29);
  const sameDay = planning.askPmWindow({ today: "2026-12-31", fromDate: "2026-12-31", toDate: "2026-12-31" });
  assert.equal(sameDay.calendarDays, 1);
  assert.equal(sameDay.weekdays, 1);
  const weekend = planning.askPmWindow({ today: "2026-11-28", toDate: "2026-11-29" });
  assert.equal(weekend.calendarDays, 2);
  assert.equal(weekend.weekdays, 0);
  assert.equal(planning.askPmPace(3, weekend).weekdayTarget, null);
  const dst = planning.askPmWindow({ today: "2026-03-06", toDate: "2026-03-09" });
  assert.equal(dst.calendarDays, 4);
  assert.equal(dst.weekdays, 2);
  assert.throws(() => planning.askPmWindow({ today: "2026-02-30" }), /valid PM date range/);
  assert.throws(() => planning.askPmWindow({ today: "2026-11-23", toDate: "2026-11-22" }), /valid PM date range/);
});

test("room-quarter completion is distinct from checklist lines, current proposals override history, and pending review stays visible", () => {
  const rows = [
    proposal("newer-approved", "room", "2026-10-01", "room:101", { is_complete: false }, { status: "approved", updated_at: "2026-11-24T00:00:00Z" }),
    proposal("mine", "room", "2026-10-01", "room:101", { completed_on: "2026-11-20", is_complete: false }),
    proposal("draft", "room", "2026-10-01", "room:102", { completed_on: null, is_complete: false }),
    proposal("rejected", "room", "2026-10-01", "room:102", { is_complete: true }, { status: "rejected" }),
    proposal("task", "daily", "2026-11-23", "property", { responses: { one: true, two: true }, task_states: { one: { status: "needs", workerChecked: true }, two: { status: "empty", workerChecked: false } } }),
    proposal("equipment-a", "equipment", "2026-12-01", "equipment:a", { is_complete: true }),
    proposal("equipment-b", "equipment", "2026-12-01", "equipment:b", { is_complete: false }),
  ];
  const result = planning.buildAskPmPlanning({
    window: planning.askPmWindow({ today: "2026-11-23" }), rooms: ["101", "102"], templates,
    entries: planning.latestAskPmEntries(rows, "actor"), proposalCount: rows.length,
    roomHistory: [{ room: "102", period_start: "2026-10-01", completed_on: "2026-10-22" }, { room: "101", period_start: "2026-07-01", completed_on: "2026-08-10" }],
  });
  assert.equal(result.roomPm.scheduled, 2, "One unit per room-quarter, not two checklist lines");
  assert.equal(result.roomPm.complete, 1);
  assert.equal(result.roomPm.remaining, 1, "An active room draft takes precedence over an old completion copy");
  assert.equal(result.roomPm.awaitingReview, 1, "Completed work awaiting review is not forced back into physical workload");
  assert.equal(result.priorRoomPm.scheduled, 6);
  assert.equal(result.priorRoomPm.complete, 1);
  assert.equal(result.priorRoomPm.remaining, 5);
  assert.equal(result.routineItems.byCadence.daily.scheduled, 78, "39 dates times two daily tasks");
  assert.equal(result.routineItems.byCadence.daily.complete, 1, "Authoritative task state overrides stale response checkbox");
  assert.equal(result.routineItems.byCadence.daily.awaitingReview, 1);
  assert.equal(result.routineItems.byCadence.weekly.scheduled, 12, "Six included weekly periods");
  assert.equal(result.routineItems.byCadence.monthly.scheduled, 4, "November and December monthly periods");
  assert.equal(result.inspections.scheduledTemplatePeriods, 1);
  assert.equal(result.inspections.periodsWithCompletedForm, 1);
  assert.equal(result.inspections.savedCompletedForms, 1);
  assert.equal(result.inspections.savedDraftForms, 1);
  const summary = planning.askPmPlanningSummary(result);
  assert.match(summary, /1 guest-room PMs remain/);
  assert.match(summary, /5 additional room-quarter PMs/);
  assert.match(summary, /checklist items, not room PMs/);
  assert.match(summary, /unit counts are not inferred/);
});

test("PM periods include current and future room quarters and explicit historical deadlines cannot divide by zero", () => {
  const input = { rooms: ["101"], templates, entries: [], roomHistory: [], proposalCount: 0 };
  const multiQuarter = planning.buildAskPmPlanning({ ...input, window: planning.askPmWindow({ today: "2026-08-31", toDate: "2026-12-31" }) });
  assert.deepEqual([...multiQuarter.roomPeriods.map(period => period.period)], ["2026-07-01", "2026-10-01"]);
  assert.equal(multiQuarter.roomPm.remaining, 2);
  const historic = planning.buildAskPmPlanning({ ...input, window: planning.askPmWindow({ today: "2026-11-23", fromDate: "2026-04-01", toDate: "2026-06-30" }) });
  assert.equal(historic.roomPm.scheduled, 1);
  assert.equal(historic.window.calendarDays, 0);
  assert.equal(planning.askPmPace(1, historic.window).calendarTarget, null);
  assert.match(planning.askPmPlanningSummary(historic), /deadline has passed/);
  assert.doesNotMatch(planning.askPmPlanningSummary(historic), /Infinity|NaN/);
});

function pmReader({ rows = [], history = [], permission = true, failHistory = false } = {}) {
  const reads = [];
  const auth = { ok: true, principal: { identity: { id: "actor" }, profile: { role: "fixture" } }, admin: { from(table) {
    const filters = [];
    const query = {
      select() { return query; }, eq(key, value) { filters.push(["eq", key, value]); return query; },
      neq(key, value) { filters.push(["neq", key, value]); return query; },
      gte(key, value) { filters.push(["gte", key, value]); return query; },
      lte(key, value) { filters.push(["lte", key, value]); return query; },
      in(key, value) { filters.push(["in", key, value]); return query; }, order() { return query; },
      range(from, to) {
        reads.push({ table, from, to, filters });
        if (failHistory && table === "cmpri_room_pm_history") return Promise.resolve({ data: null, error: { message: "test unavailable" } });
        let selected = table === "cmpri_pm_proposals" ? rows : history;
        for (const [kind, key, value] of filters) selected = selected.filter(row => {
          if (key === "hotel_id") return true;
          if (kind === "eq") return row[key] === value;
          if (kind === "neq") return row[key] !== value;
          if (kind === "gte") return row[key] >= value;
          if (kind === "lte") return row[key] <= value;
          return value.includes(row[key]);
        });
        return Promise.resolve({ data: selected.slice(from, to + 1), error: null });
      },
    };
    return query;
  } } };
  const api = loadTs("src/lib/server/ask-cmpri-pm.ts", {
    "server-only": {}, "@/lib/ask-cmpri/pm-planning": planning,
    "@/lib/constants": { HOTEL_ID: "property" },
    "@/lib/pm/catalog": { PM_ROOM_NUMBERS: ["101", "102"], PM_TEMPLATES: templates },
    "@/lib/pm/linked-form-review": { projectLinkedFormReviews: (entries) => entries },
    "@/lib/server/access": { allows: (_, capability) => { assert.equal(capability, "view_pm"); return permission; } },
    "@/lib/server/paginated-query": loadTs("src/lib/server/paginated-query.ts"),
  }, { Date, Intl, Map, Set });
  return { api, auth, reads };
}

test("PM role denial and invalid room return a useful message before reading any records", async () => {
  const denied = pmReader({ permission: false });
  assert.equal(denied.api.canReadAskPm(denied.auth.principal), false);
  const result = await denied.api.readAskPm(denied.auth, { today: "2026-11-23" });
  assert.match(result.missing, /role permissions/);
  assert.equal(result.items.length, 0);
  assert.equal(denied.reads.length, 0);
  const invalid = pmReader();
  assert.match((await invalid.api.readAskPm(invalid.auth, { rooms: ["425"], today: "2026-11-23" })).missing, /Room 425/);
  assert.equal(invalid.reads.length, 0);
});

test("PM reads paginate all records, keep hotel filters, and never produce a count from a partial source", async () => {
  const rows = Array.from({ length: 1000 }, (_, index) => proposal(String(index), "room", "2026-04-01", "room:101", { is_complete: false }));
  rows.push(proposal("last-page-completion", "room", "2026-10-01", "room:101", { is_complete: true }));
  const full = pmReader({ rows, history: [{ room: "102", period_start: "2026-10-01", completed_on: "2026-11-01" }] });
  const result = await full.api.readAskPm(full.auth, { today: "2026-11-23" });
  assert.equal(result.missing, undefined);
  assert.equal(result.planning.sourceRecords.proposals, 1001);
  assert.equal(result.planning.roomPm.complete, 2);
  assert.equal(result.planning.roomPm.remaining, 0);
  assert.ok(full.reads.some(read => read.table === "cmpri_pm_proposals" && read.from === 1000));
  assert.ok(full.reads.every(read => read.filters.some(([kind, key, value]) => kind === "eq" && key === "hotel_id" && value === "property")));
  assert.ok(result.items.every(item => item.href === "/engineering/preventive-maintenance"));
  const filtered = pmReader({ rows, history: [{ room: "102", period_start: "2026-10-01", completed_on: "2026-11-01" }] });
  const room = await filtered.api.readAskPm(filtered.auth, { today: "2026-11-23", rooms: ["Room 101"] });
  assert.equal(room.planning.roomPm.scheduled, 1);
  assert.equal(room.planning.roomPm.complete, 1);
  const broken = pmReader({ rows, failHistory: true });
  const failure = await broken.api.readAskPm(broken.auth, { today: "2026-11-23" });
  assert.match(failure.missing, /could not be fully read/);
  assert.equal(failure.planning, undefined);
  assert.equal(failure.items.length, 0);
});
