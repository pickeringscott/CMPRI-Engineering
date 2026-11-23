import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const loyalty = loadTs("src/lib/loyalty-tier.ts");
const native = loadTs("src/lib/ask-cmpri/native-query.ts", { "@/lib/loyalty-tier": loyalty });
const tiers = ["Base", "Silver", "Gold", "Platinum", "Titanium", "Ambassador"];
const plain = (value) => JSON.parse(JSON.stringify(value));
const query = native.queryAskNativeSnapshot;
const membershipRows = tiers.map((tier, index) => ({ room: String(101 + index), loyalty_tier: tier }));

test("all six Bonvoy tiers are searchable in rank order and unknown membership stays separate from Base", () => {
  const rows = [membershipRows[3], { room: "200", loyalty_tier: null }, membershipRows[5], membershipRows[0],
    { room: "201", loyalty_tier: "" }, membershipRows[4], membershipRows[2],
    { room: "202", loyalty_tier: "Unrecognized" }, membershipRows[1]];
  const before = plain(rows);
  const ascending = query({ rows }, { path: "rows", sort: [{ path: "loyalty_tier", type: "bonvoy", direction: "asc" }] });
  assert.deepEqual(plain(ascending.rows.slice(0, 6).map(row => row.loyalty_tier)), tiers);
  assert.deepEqual(plain(ascending.rows.slice(6).map(row => row.room)), ["200", "201", "202"]);
  const descending = query(rows, { sort: [{ path: "loyalty_tier", type: "bonvoy", direction: "desc" }] });
  assert.deepEqual(plain(descending.rows.slice(0, 6).map(row => row.loyalty_tier)), [...tiers].reverse());
  assert.deepEqual(plain(descending.rows.slice(6).map(row => row.room)), ["200", "201", "202"], "Missing tiers stay last even in descending order");
  assert.deepEqual(rows, before, "Sorting must not rearrange the authorized source snapshot");
  for (const tier of tiers) {
    const exact = query(rows, { filters: [{ path: "loyalty_tier", operator: "eq", value: tier }] });
    assert.equal(exact.matchedCount, 1, tier);
    assert.equal(exact.rows[0].loyalty_tier, tier);
  }
  const base = query(rows, { filters: [{ path: "loyalty_tier", operator: "tierAtMost", value: "Base" }] });
  assert.deepEqual(plain(base.rows.map(row => row.loyalty_tier)), ["Base"]);
  assert.equal(query(rows, { filters: [{ path: "loyalty_tier", operator: "missing" }] }).matchedCount, 2);
  assert.equal(loyalty.loyaltyTier("Unrecognized"), null);
  assert.equal(loyalty.loyaltyRank("Unrecognized"), 0);
});

test("Bonvoy minimum and maximum filters work at every tier, including recognized source labels", () => {
  const rows = [...membershipRows, { room: "900", loyalty_tier: null }, { room: "901", loyalty_tier: "Unknown" }];
  for (const [index, tier] of tiers.entries()) {
    const minimum = query(rows, { filters: [{ path: "loyalty_tier", operator: "tierAtLeast", value: tier }] });
    const maximum = query(rows, { filters: [{ path: "loyalty_tier", operator: "tierAtMost", value: tier }] });
    assert.deepEqual(plain(minimum.rows.map(row => row.loyalty_tier)), tiers.slice(index), `At least ${tier}`);
    assert.deepEqual(plain(maximum.rows.map(row => row.loyalty_tier)), tiers.slice(0, index + 1), `At most ${tier}`);
  }
  const sourceLabels = ["Member", "Base Member", "Bonvoy Gold Elite", "Marriott Bonvoy Platinum Elite", "  titanium elite  "];
  const recognized = sourceLabels.map((loyalty_tier, index) => ({ room: String(index), loyalty_tier }));
  assert.equal(query(recognized, { filters: [{ path: "loyalty_tier", operator: "tierAtMost", value: "Base" }] }).matchedCount, 2);
  assert.equal(query(recognized, { filters: [{ path: "loyalty_tier", operator: "tierAtLeast", value: "Gold" }] }).matchedCount, 3);
  assert.equal(query(recognized, { filters: [{ path: "loyalty_tier", operator: "tierAtLeast", value: "Unrecognized" }] }).matchedCount, 0);
});

test("current and incoming guest names and Bonvoy tiers are independently queryable", () => {
  const snapshot = { rows: [
    { room: "101", guest_name: "Current Gold", loyalty_tier: "Gold", incoming_name: "Arriving Ambassador", incoming_loyalty_tier: "Ambassador" },
    { room: "102", guest_name: "Current Ambassador", loyalty_tier: "Ambassador", incoming_name: "Arriving Base", incoming_loyalty_tier: "Base" },
    { room: "103", guest_name: "Unknown Member", loyalty_tier: null, incoming_name: "Arriving Gold", incoming_loyalty_tier: "Gold" },
  ] };
  const current = query(snapshot, { path: "rows", filters: [{ path: "loyalty_tier", operator: "tierAtLeast", value: "Titanium" }], fields: ["room", "guest_name", "loyalty_tier"] });
  assert.deepEqual(plain(current.rows), [{ room: "102", guest_name: "Current Ambassador", loyalty_tier: "Ambassador" }]);
  const incoming = query(snapshot, { path: "rows", filters: [{ path: "incoming_loyalty_tier", operator: "tierAtLeast", value: "Titanium" }], fields: ["room", "incoming_name", "incoming_loyalty_tier"] });
  assert.deepEqual(plain(incoming.rows), [{ room: "101", incoming_name: "Arriving Ambassador", incoming_loyalty_tier: "Ambassador" }]);
  assert.equal(query(snapshot, { path: "rows", filters: [
    { path: "loyalty_tier", operator: "missing" }, { path: "incoming_loyalty_tier", operator: "eq", value: "Gold" },
  ] }).rows[0].room, "103");
  assert.deepEqual(plain(native.askNativeValue(snapshot, "$.rows[*].incoming_loyalty_tier")), ["Ambassador", "Base", "Gold"]);
});

test("guest names match without case or accent differences and room numbers sort numerically", () => {
  const rows = [
    { room: "101", guest_name: "José Muñoz" },
    { room: "20", guest_name: "JOSE MUNOZ" },
    { room: "3", guest_name: "  José Muñoz  " },
    { room: "103B", guest_name: "Other Guest" },
    { room: "103A", guest_name: "Another Guest" },
    { room: "2", guest_name: "Other Guest" },
  ];
  const names = query(rows, { filters: [{ path: "guest_name", operator: "eq", value: "jose munoz" }], sort: [{ path: "room", direction: "asc" }] });
  assert.deepEqual(plain(names.rows.map(row => row.room)), ["3", "20", "101"]);
  assert.equal(query(rows, { filters: [{ path: "guest_name", operator: "contains", value: "MUÑOZ" }] }).matchedCount, 3);
  const rooms = query(rows, { sort: [{ path: "room", direction: "asc" }], fields: ["room"] });
  assert.deepEqual(plain(rooms.rows.map(row => row.room)), ["2", "3", "20", "101", "103A", "103B"]);
  const reverse = query(rows, { sort: [{ path: "room", direction: "desc" }], fields: ["room"] });
  assert.deepEqual(plain(reverse.rows.map(row => row.room)), ["103B", "103A", "101", "20", "3", "2"]);
});

test("Bonvoy grouping and aggregates use every authorized row before display pagination", () => {
  const rows = Array.from({ length: 612 }, (_, index) => ({
    room: String(index + 1), loyalty_tier: tiers[index % 6], stay_nights: index + 1,
  }));
  const first = query({ rows }, { path: "rows", groupBy: "loyalty_tier", aggregate: "count", limit: 200 });
  assert.equal(first.inputCount, 612);
  assert.equal(first.matchedCount, 612);
  assert.equal(first.returnedCount, 200);
  assert.equal(first.nextOffset, 200);
  assert.equal(first.aggregate, 612);
  assert.deepEqual(plain(first.groups.map(group => [group.group, group.count, group.value])), tiers.map(tier => [tier, 102, 102]));
  const tail = query({ rows }, { path: "rows", groupBy: "loyalty_tier", aggregate: "count", offset: 600, limit: 200 });
  assert.equal(tail.returnedCount, 12);
  assert.equal(tail.nextOffset, null);
  assert.equal(tail.aggregate, 612);
  assert.deepEqual(plain(tail.groups), plain(first.groups), "Grouping cannot change when the requested display page changes");
  const goldAndAbove = query(rows, { filters: [{ path: "loyalty_tier", operator: "tierAtLeast", value: "Gold" }], aggregate: "sum", aggregatePath: "stay_nights", limit: 2 });
  const expected = rows.filter(row => ["Gold", "Platinum", "Titanium", "Ambassador"].includes(row.loyalty_tier));
  assert.equal(goldAndAbove.matchedCount, 408);
  assert.equal(goldAndAbove.returnedCount, 2);
  assert.equal(goldAndAbove.aggregate, expected.reduce((sum, row) => sum + row.stay_nights, 0));
  const average = query(rows, { aggregate: "average", aggregatePath: "stay_nights", limit: 1 });
  assert.equal(average.aggregate, 306.5);
  const distinct = query(rows, { aggregate: "distinct", aggregatePath: "loyalty_tier", limit: 1 });
  assert.deepEqual(plain(distinct.aggregate), tiers);
  assert.match(first.countingScope, /source API's own coverage and pagination metadata/);
});

test("combined property filters select the intended stay without mixing status, checkout, group, or membership", () => {
  const match = { room: "210", room_status: "Occupied Dirty", group_name: "CN Railway", checkout_date: "2026-11-23", loyalty_tier: "Platinum" };
  const rows = [match,
    { ...match, room: "110" },
    { ...match, room: "211", loyalty_tier: "Silver" },
    { ...match, room: "212", loyalty_tier: null },
    { ...match, room: "214", room_status: "Vacant Ready" },
    { ...match, room: "215", checkout_date: "2026-11-24" },
    { ...match, room: "216", group_name: "Other Group" },
  ];
  const filters = [
    { path: "room", operator: "gte", value: "200" }, { path: "room", operator: "lt", value: "300" },
    { path: "room_status", operator: "contains", value: "occupied" },
    { path: "group_name", operator: "contains", value: "cn" },
    { path: "checkout_date", operator: "lte", value: "2026-11-23" },
    { path: "loyalty_tier", operator: "tierAtLeast", value: "Gold" },
  ];
  const result = query(rows, { filters, match: "all" });
  assert.equal(result.matchedCount, 1);
  assert.equal(result.rows[0].room, "210");
  const either = query(rows, { match: "any", filters: [
    { path: "room_status", operator: "eq", value: "Vacant Ready" },
    { path: "checkout_date", operator: "eq", value: "2026-11-24" },
  ] });
  assert.deepEqual(plain(either.rows.map(row => row.room)), ["214", "215"]);
  assert.equal(query(rows, { filters: [{ path: "room", operator: "in", value: ["210", "216"] }] }).matchedCount, 2);
});

test("authorized room operations join to every ticket for the same room without joining missing keys", () => {
  const rooms = [
    { room: "101", guest_name: "Gold Guest", loyalty_tier: "Gold" },
    { room: "102", guest_name: "Titanium Guest", loyalty_tier: "Titanium" },
    { room: "103", guest_name: "Base Guest", loyalty_tier: "Base" },
    { room: null, guest_name: "No Room" },
  ];
  const tickets = [
    { id: "a", room: "Room 101", status: "Open" },
    { id: "b", room: "101", status: "Closed" },
    { id: "c", room: 102, status: "In Progress" },
    { id: "d", room: null, status: "Open" },
    { id: "e", room: "999", status: "Open" },
  ];
  const inner = native.joinAskNativeRows(rooms, tickets, "room", "room");
  assert.deepEqual(plain(inner.map(row => [row.left.room, row.right.id])), [["101", "a"], ["101", "b"], ["102", "c"]]);
  const activeGold = query(inner, { filters: [
    { path: "left.loyalty_tier", operator: "tierAtLeast", value: "Gold" },
    { path: "right.status", operator: "ne", value: "Closed" },
  ], fields: ["left.room", "left.guest_name", "right.id", "right.status"] });
  assert.deepEqual(plain(activeGold.rows), [
    { "left.room": "101", "left.guest_name": "Gold Guest", "right.id": "a", "right.status": "Open" },
    { "left.room": "102", "left.guest_name": "Titanium Guest", "right.id": "c", "right.status": "In Progress" },
  ]);
  const left = native.joinAskNativeRows(rooms, tickets, "room", "room", "left");
  assert.equal(left.length, 5);
  assert.equal(left.find(row => row.left.room === "103").right, null);
  assert.equal(left.find(row => row.left.room === null).right, null);
});

test("nested array queries use all values for exclusion and never follow inherited or prototype fields", () => {
  const snapshot = { rows: [{ room: "101", people: [{ name: "José" }, { name: "Sam" }] }, { room: "102", people: [{ name: "Pat" }] }] };
  assert.deepEqual(plain(native.askNativeValue(snapshot, "rows[0].people[*].name")), ["José", "Sam"]);
  assert.equal(query(snapshot, { path: "rows", filters: [{ path: "people.name", operator: "contains", value: "jose" }] }).rows[0].room, "101");
  assert.equal(query(snapshot, { path: "rows", filters: [{ path: "people.name", operator: "notContains", value: "jose" }] }).rows[0].room, "102");
  const inherited = Object.create({ secret: "never traverse" });
  inherited.room = "101";
  assert.equal(native.askNativeValue(inherited, "secret"), undefined);
  const unsafe = ["__proto__.polluted", "constructor.prototype", "rows[0].constructor", "$.rows[*].__proto__", "rows.*.prototype"];
  for (const path of unsafe) assert.throws(() => native.askNativeValue(snapshot, path), /Invalid data field/, path);
  assert.throws(() => query(snapshot, { path: "rows", filters: [{ path: "constructor.name", operator: "exists" }] }), /Invalid data field/);
  assert.throws(() => query(snapshot, { path: "rows", fields: ["__proto__"] }), /Invalid data field/);
  assert.throws(() => query(snapshot, { path: "rows", groupBy: "constructor.prototype" }), /Invalid data field/);
  assert.throws(() => native.joinAskNativeRows(snapshot.rows, snapshot.rows, "__proto__", "room"), /Invalid data field/);
  assert.equal(Object.prototype.polluted, undefined);
});
