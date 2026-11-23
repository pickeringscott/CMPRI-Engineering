import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import * as zod from "zod";
import * as reference from "../src/lib/work-order-reference.js";
import { loadTs } from "./helpers/load-ts.mjs";

const roles = loadTs("src/lib/server/roles.ts");
const readPolicy = loadTs("src/lib/work-order-read-policy.ts");
const editPolicy = loadTs("src/lib/work-order-edit-policy.ts", { "./server/roles": roles, "./work-order-read-policy": readPolicy });
const access = loadTs("src/lib/server/access.ts", { "./roles": roles });
const media = loadTs("src/lib/work-order-media.ts");
const bucket = "staff-note-files";
const hotel = randomUUID();
const location = { id: randomUUID(), name: "Room 212", room_number: "212" };
const photo = { uploadId: randomUUID(), name: "problem.jpg", type: "", size: 10, sha256: "a".repeat(64) };
const create = { candidateAction: "create", rooms: ["212"], actionValue: "Sink leak", requestedPriority: "Urgent" };
const ascii = (value, limit = 500) => typeof value === "string" ? value.trim().slice(0, limit) : "";

class NativeRequest extends Request {
  constructor(input, init) {
    super(input, init);
    this.nextUrl = new URL(input);
  }
}

function fixture(role = "Front Desk") {
  const actor = randomUUID();
  const principal = {
    identity: { id: actor }, profile: { id: actor, role, full_name: "Sample User", active: true },
    hotelId: hotel, membership: { user_id: actor, hotel_id: hotel, role: roles.membershipRole(role), active: true },
    permissions: [],
  };
  const markers = new Map();
  const orders = new Map();
  let saves = 0;
  let interrupt;
  const auth = {
    ok: true, principal,
    admin: {
      storage: { from(name) {
        assert.equal(name, bucket);
        return {
          async download(path) { return markers.has(path) ? { data: new Blob([markers.get(path)]) } : { error: { statusCode: 404 } }; },
          async upload(path, value, options) {
            assert.equal(options.upsert, false);
            if (markers.has(path)) return { error: { statusCode: 409 } };
            markers.set(path, value);
            return {};
          },
        };
      } },
      from(table) {
        assert.equal(table, "work_orders");
        const filters = {};
        const reader = {
          select() { return reader; }, eq(key, value) { filters[key] = value; return reader; },
          async maybeSingle() {
            assert.equal(filters.hotel_id, hotel);
            return { data: orders.get(filters.id) };
          },
        };
        return reader;
      },
    },
  };
  const native = {
    async POST(request) {
      saves++;
      const body = await request.json();
      if (interrupt === "before") throw new Error("Synthetic failure before commit");
      const row = { id: body.creation_id, created_by: actor, display_id: "WO#777", hotel_id: hotel, status: "Pending Verification" };
      assert.equal(body.orders[0].location_id, location.id);
      assert.equal(body.orders[0].priority, "Urgent");
      orders.set(row.id, row);
      if (interrupt === "after") throw new Error("Synthetic loss after commit");
      return Response.json({ work_orders: [row] });
    },
    async PATCH(request, { params }) {
      const { id } = await params;
      const { expected_revision, status } = await request.json();
      const row = orders.get(id);
      assert.equal(expected_revision, row.revision);
      orders.set(id, { ...row, status, revision: row.revision + 2 });
      saves++;
      return Response.json({ saved: true, error: "Changes were saved. Reload before making more changes." });
    },
  };
  const actions = loadTs("src/lib/server/ask-cmpri-actions.ts", {
    "server-only": {}, zod, "next/server": { NextRequest: NativeRequest }, "@/lib/server/access": access,
    "@/lib/server/roles": roles, "@/lib/uuid": loadTs("src/lib/uuid.ts"),
    "@/lib/work-order-attribution": loadTs("src/lib/work-order-attribution.ts", { "@/lib/server/roles": roles }),
    "@/lib/work-order-reference.js": reference, "@/lib/work-order-edit-policy": editPolicy,
    "@/lib/server/work-order-assignment": loadTs("src/lib/server/work-order-assignment.ts", { "./roles": roles }),
    "@/lib/server/manual-preview": { manualPreviewReadOnly: () => false },
    "@/lib/work-order-media": media, "@/lib/staff-note-media": { STAFF_FILE_BUCKET: bucket },
    "@/lib/i18n/ticket-media": loadTs("src/lib/i18n/ticket-media.ts"),
    "./ask-cmpri-data": { askText: ascii, askOrderItem: () => ({}) },
    "@/app/api/work-orders/route": native,
    "@/app/api/work-orders/[id]/route": native,
  }, { URL, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "synthetic confirmation fixture" } } });
  const action = extra => actions.beginAskAction({
    plan: create, principal, orders: [], locations: [location], language: "es", staffName: "María",
    photoRequested: true, attachments: [photo], targetExplicit: true, ...extra,
  });
  const request = new NativeRequest("https://cmpri.test/api/ask-cmpri", { headers: { Authorization: "Bearer synthetic" } });
  return { actions, auth, action, orders, setInterrupt: value => { interrupt = value; }, saves: () => saves,
    confirm: (token, options) => actions.confirmAskAction(request, auth, token, options) };
}

test("confirm and cancel compete on one marker and a cancelled proposal cannot be replayed", async () => {
  const first = fixture();
  const cancelToken = first.action().proposal.token;
  const [cancel, attemptedSave] = await Promise.all([first.confirm(cancelToken, { cancel: true }), first.confirm(cancelToken)]);
  assert.equal(cancel.status, 200);
  assert.equal(attemptedSave.status, 409);
  assert.equal(first.saves(), 0);
  assert.equal((await first.confirm(cancelToken)).status, 409);

  const second = fixture();
  const token = second.action().proposal.token;
  const results = await Promise.all([second.confirm(token), second.confirm(token)]);
  assert.equal(second.saves(), 1);
  assert.ok(results.some(result => result.status === 200));
  assert.equal((await second.confirm(token, { recover: true })).status, 200);
  assert.equal(second.saves(), 1);
});

test("recovery finds a committed create after a lost response and will not initiate an interrupted action", async () => {
  for (const outcome of ["before", "after"]) {
    const route = fixture();
    const token = route.action().proposal.token;
    assert.equal((await route.confirm(token, { recover: true })).status, 409);
    assert.equal(route.saves(), 0);
    route.setInterrupt(outcome);
    assert.equal((await route.confirm(token)).status, 503);
    const recovered = await route.confirm(token, { recover: true });
    assert.equal(recovered.status, outcome === "after" ? 200 : 409);
    assert.equal(route.saves(), 1);
    if (outcome === "after") assert.match(recovered.result.title, /verificación de Ingeniería/);
  }
});

test("the Spanish photo requirement accepts a valid extension without MIME and binds the approved bytes and user", async () => {
  const route = fixture();
  assert.equal(route.action({ attachments: [{ ...photo, name: "invalid.avif", type: "image/avif" }] }).needs, "photo");
  assert.equal(route.action({ attachments: [{ ...photo, sha256: undefined }] }).needs, "photo");
  const proposal = route.action().proposal;
  assert.equal(proposal.attachments[0].name, "problem.jpg");
  const { result } = await route.confirm(proposal.token);
  const { id, attachmentToken } = result.savedOrder;
  const verify = (mediaFile, overrides = {}) => route.actions.verifyAskAttachment(attachmentToken, { ...route.auth.principal, ...overrides }, id, mediaFile);
  assert.equal(verify(photo), true);
  assert.equal(verify({ ...photo, sha256: "b".repeat(64) }), false);
  assert.equal(verify(photo, { identity: { id: randomUUID() } }), false);
  assert.equal(verify(photo, { hotelId: randomUUID() }), false);
});

test("status and priority proposals disclose their native effects and require an explicit work order", () => {
  const route = fixture("Chief Engineer");
  const row = { id: randomUUID(), display_id: "WO#777", hotel_id: hotel, revision: 2, status: "Closed", priority: "Urgent",
    ranker_base_priority: "Medium", technician_name: "", last_assigned_technician_name: "Assigned Technician" };
  const status = { ...create, candidateAction: "status", actionValue: "In Progress" };
  assert.equal(route.action({ plan: status, orders: [row], targetExplicit: false }).needs, "workOrder");
  const proposal = route.action({ plan: status, orders: [row], targetExplicit: true }).proposal;
  assert.match(proposal.effects[0], /Assigned Technician/);
  const priority = route.action({ plan: { ...status, candidateAction: "priority", actionValue: "Urgent" }, orders: [row], targetExplicit: true });
  assert.match(priority.unavailable, /Medium/);
});

test("a changed work-order revision rejects the original confirmation without starting an edit", async () => {
  const route = fixture("Chief Engineer");
  const row = { id: randomUUID(), display_id: "WO#888", hotel_id: hotel, revision: 2, status: "In Progress", priority: "Medium",
    technician_name: "Assigned Technician" };
  const proposal = route.action({ plan: { ...create, candidateAction: "status", actionValue: "Completed" }, orders: [row] }).proposal;
  route.orders.set(row.id, { ...row, revision: 3 });
  const result = await route.confirm(proposal.token);
  assert.equal(result.status, 409);
  assert.match(result.result.summary, /cambió/);
  assert.equal(route.saves(), 0);
});

test("an edit committed without a fresh row is confirmed without showing stale work-order values", async () => {
  const route = fixture("Chief Engineer");
  const row = { id: randomUUID(), display_id: "WO#888", hotel_id: hotel, revision: 2, status: "In Progress", priority: "Medium",
    technician_name: "Assigned Technician" };
  route.orders.set(row.id, row);
  const proposal = route.action({ plan: { ...create, candidateAction: "status", actionValue: "Completed" }, orders: [row], language: "en" }).proposal;
  const { result, status } = await route.confirm(proposal.token);
  assert.equal(status, 200);
  assert.match(result.summary, /saved.*reopen/i);
  assert.equal(result.items[0].record.id, row.id);
  assert.equal(route.orders.get(row.id).status, "Completed");
  assert.equal((await route.confirm(proposal.token, { recover: true })).status, 200);
  assert.equal(route.saves(), 1);
});
