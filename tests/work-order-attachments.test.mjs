import assert from "node:assert/strict";
import test from "node:test";
import { uploadWorkOrderAttachment } from "../src/lib/work-order-attachment-upload.ts";
import { resolveWorkOrderImages } from "../src/lib/work-orders/attachment-response.ts";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

const hotelId = "c81ad01a-7a9f-4880-ac1c-5e849f30bad6";
const workOrderId = "00000000-0000-0000-0000-000000000042";
function compileModule(relativePath, dependencies = {}) {
  const exports = {};
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected module dependency: ${name}`);
    },
  });
  return exports;
}

const roleModule = compileModule("../src/lib/server/roles.ts");
const accessModule = compileModule("../src/lib/server/access.ts", { "./roles": roleModule });
const assignmentModule = compileModule("../src/lib/server/work-order-assignment.ts", { "./roles": roleModule });
const uuidModule = compileModule("../src/lib/uuid.ts");
const routeSource = readFileSync(new URL("../src/app/api/work-orders/[id]/attachments/route.ts", import.meta.url), "utf8");
const workOrderPageSource = readFileSync(new URL("../src/app/work-orders/page.tsx", import.meta.url), "utf8");
const routeCode = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const roleCases = [
  { role: "Engineer", dashboard: true },
  { role: "Chief Engineer", dashboard: true },
  { role: "Engineering Manager", dashboard: true },
  { role: "Maintenance Technician", dashboard: true },
  { role: "Technician", dashboard: true },
  { role: "Regional Maintenance", dashboard: true },
  { role: "General Manager", dashboard: false },
  { role: "Assistant General Manager", dashboard: false },
  { role: "Front Desk", dashboard: false },
  { role: "Front Desk Manager", dashboard: false },
  { role: "Housekeeping", dashboard: false },
  { role: "Lead Housekeeper", dashboard: false },
  { role: "Senior Management", dashboard: true },
  { role: "System Administrator", dashboard: true },
];

function fixture(options = {}) {
  const role = options.role || "Front Desk";
  const userId = options.userId || "user-a";
  const filters = [];
  const storageCalls = [];
  const logs = [];
  const record = {
    id: workOrderId,
    hotel_id: options.workOrderHotelId || hotelId,
    created_by: options.createdBy === undefined ? "owner" : options.createdBy,
    technician_name: options.technicianName ?? null,
    status: options.status || "Open",
  };
  const permissions = [
    "manage_work_orders",
    "close_work_orders",
    "manage_assets",
    "manage_rooms",
    "manage_users",
    "manage_pm",
    "manage_integrations",
  ].map((permission) => ({ role, permission, allowed: true }));
  const principal = {
    identity: { id: userId },
    profile: { id: userId, role, full_name: options.fullName || "Test User", active: true },
    hotelId,
    membership: { user_id: userId, hotel_id: hotelId, role: options.membershipRole || roleModule.membershipRole(role), active: true },
    permissions,
  };
  const admin = {
    from(table) {
      assert.equal(table, "work_orders");
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        maybeSingle: async () => ({
          data: options.lookupWorkOrder ? await options.lookupWorkOrder(filters) : filters.every(([column, value]) => column !== "hotel_id" || record.hotel_id === value) ? record : null,
          error: options.lookupError ? new Error("database unavailable") : null,
        }),
      };
      return query;
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "asset-documentation");
        return {
          upload: async (path, file, uploadOptions) => {
            storageCalls.push({ operation: "upload", path, file, uploadOptions });
            if (options.persistDirectory && !options.uploadError) {
              const target = join(options.persistDirectory, path);
              await mkdir(dirname(target), { recursive: true });
              await writeFile(target, Buffer.from(await file.arrayBuffer()));
            }
            return { error: options.uploadError ? new Error("storage unavailable") : null };
          },
          list: async (prefix, listOptions) => {
            storageCalls.push({ operation: "list", prefix, listOptions });
            return {
              data: options.persistDirectory ? (await readdir(join(options.persistDirectory, prefix))).map(name => ({ name, metadata: { mimetype: "image/png" } })) : options.files || [{ name: "photo.png", metadata: { mimetype: "image/png" } }],
              error: options.listError ? new Error("storage unavailable") : null,
            };
          },
          createSignedUrl: async (path, expiresIn) => {
            storageCalls.push({ operation: "sign", path, expiresIn });
            if (options.signError) return { data: null, error: new Error("signing unavailable") };
            if (options.missingSignedUrl) return { data: {}, error: null };
            return { data: { signedUrl: "http://local.invalid/signed-photo" }, error: null };
          },
        };
      },
    },
  };
  const exports = {};
  vm.runInNewContext(routeCode, {
    exports,
    console: { error: (...args) => logs.push(args) },
    crypto,
    File,
    require(name) {
      if (name === "next/server") return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers }) } };
      if (name === "@/lib/constants") return { HOTEL_ID: hotelId };
      if (name === "@/lib/server/access") return accessModule;
      if (name === "@/lib/server/auth") return { requireUser: async () => options.authenticated === false ? null : { principal, admin } };
      if (name === "@/lib/server/roles") return roleModule;
      if (name === "@/lib/server/work-order-assignment") return assignmentModule;
      if (name === "@/lib/uuid") return uuidModule;
      throw new Error(`Unexpected attachment route dependency: ${name}`);
    },
  });

  const request = (file, uploadId) => ({
    headers: new Headers(uploadId ? { "x-upload-id": uploadId } : {}),
    formData: async () => {
      if (options.formDataError) throw new Error("invalid form");
      const form = new FormData();
      if (file) form.append("photo", file);
      return form;
    },
  });
  return {
    filters,
    storageCalls,
    logs,
    get: () => exports.GET({}, { params: Promise.resolve({ id: workOrderId }) }),
    post: (file, uploadId) => exports.POST(request(file, uploadId), { params: Promise.resolve({ id: workOrderId }) }),
    getMalformed: () => exports.GET({}, { params: Promise.resolve({ id: "test-id" }) }),
    postMalformed: (file) => exports.POST(request(file), { params: Promise.resolve({ id: "test-id" }) }),
  };
}

function photo(name = "photo.png", type = "image/png", size = 16) {
  const signatures = {
    "image/jpeg": [0xff, 0xd8, 0xff],
    "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "image/gif": [...Buffer.from("GIF89a")],
    "image/webp": [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")],
    "image/bmp": [...Buffer.from("BM")],
    "image/heic": [0, 0, 0, 0, ...Buffer.from("ftypheic")],
    "image/heif": [0, 0, 0, 0, ...Buffer.from("ftypmif1")],
  };
  const bytes = new Uint8Array(size);
  const extensionType = name.toLowerCase().endsWith(".jpg") || name.toLowerCase().endsWith(".jpeg")
    ? "image/jpeg"
    : `image/${name.toLowerCase().split(".").pop()}`;
  const signature = signatures[type] || signatures[extensionType];
  if (signature) bytes.set(signature.slice(0, size));
  return new File([bytes], name, { type });
}

test("attachment GET and POST fail closed when unauthenticated and bind lookups to the configured property", async () => {
  const unauthenticated = fixture({ authenticated: false });
  assert.equal((await unauthenticated.get()).status, 401);
  assert.equal((await unauthenticated.post(photo())).status, 401);
  assert.equal(unauthenticated.filters.length, 0);
  assert.equal(unauthenticated.storageCalls.length, 0);

  const crossProperty = fixture({ workOrderHotelId: "00000000-0000-0000-0000-000000000099" });
  assert.equal((await crossProperty.get()).status, 404);
  assert.ok(crossProperty.filters.some(([column, value]) => column === "hotel_id" && value === hotelId));
  assert.equal(crossProperty.storageCalls.length, 0);

  const unavailable = fixture({ lookupError: true });
  assert.equal((await unavailable.get()).status, 503);
  assert.equal(unavailable.storageCalls.length, 0);
});

test("attachment ownership and cross-role API access match the role capability boundary", async () => {
  for (const { role, dashboard } of roleCases) {
    const ownOrder = fixture({ role, userId: "owner", createdBy: "owner" });
    assert.equal((await ownOrder.get()).status, 200, `${role} reads own attachment list`);
    assert.equal((await ownOrder.post(photo())).status, 200, `${role} uploads to own order`);

    const otherUserOrder = fixture({ role, userId: "user-a", createdBy: "other-user" });
    const canReadOtherOrder = dashboard || roleModule.roleAllows(role, "view_work_orders") || roleModule.roleAllows(role, "add_work_order_notes");
    assert.equal((await otherUserOrder.get()).status, canReadOtherOrder ? 200 : 403, `${role} reads another user's attachments`);
    const canEditOtherOrder = roleModule.roleAllows(role, "edit_tickets") || roleModule.roleAllows(role, "review_tickets");
    const canCommentOnOtherOrder = roleModule.roleAllows(role, "add_work_order_notes");
    assert.equal((await otherUserOrder.post(photo())).status, canEditOtherOrder || canCommentOnOtherOrder ? 200 : 403, `${role} uploads to another user's order`);
  }

  for (const role of ["General Manager", "Assistant General Manager", "Front Desk Manager"]) {
    const closedOrder = fixture({ role, userId: "reader", createdBy: "other-user", status: "Closed" });
    assert.equal((await closedOrder.get()).status, 403, `${role} cannot read closed-order attachments`);
    assert.equal((await closedOrder.post(photo())).status, 403, `${role} cannot upload to closed work orders`);
    assert.equal(closedOrder.storageCalls.length, 0);
  }

  const assignedToAnother = fixture({
    role: "Maintenance Technician",
    userId: "technician",
    createdBy: "other-user",
    fullName: "Morgan Lee",
    technicianName: "Other Technician",
  });
  assert.equal((await assignedToAnother.get()).status, 200);
  assert.equal((await assignedToAnother.post(photo())).status, 200);

  const pendingForTechnician = fixture({
    role: "Maintenance Technician",
    userId: "technician",
    createdBy: "front-desk-user",
    fullName: "Morgan Lee",
    status: "Pending Verification",
  });
  assert.equal((await pendingForTechnician.get()).status, 403);
  assert.equal((await pendingForTechnician.post(photo())).status, 403);
  assert.equal(pendingForTechnician.storageCalls.length, 0);
});

test("attachment uploads validate type, file signature, and the inclusive 10 MiB size limit", async () => {
  const invalidCases = [
    { file: null, message: "Choose an image" },
    { file: photo("notes.txt", "text/plain"), message: "Only JPEG" },
    { file: photo("vector.svg", "image/svg+xml"), message: "Only JPEG" },
    { file: photo("mislabeled.png", "image/jpeg"), message: "Only JPEG" },
    { file: new File([new Uint8Array(16)], "spoofed.png", { type: "image/png" }), message: "not a valid supported image" },
    { file: photo("empty.png", "image/png", 0), message: "10 MB or smaller" },
    { file: photo("oversized.png", "image/png", 10 * 1024 * 1024 + 1), message: "10 MB or smaller" },
  ];
  for (const { file, message } of invalidCases) {
    const route = fixture({ role: "Chief Engineer", userId: "owner", createdBy: "owner" });
    const response = await route.post(file);
    assert.equal(response.status, 400);
    assert.match(response.body.error, new RegExp(message));
    assert.equal(route.storageCalls.length, 0);
  }

  const atLimit = fixture({ role: "Chief Engineer", userId: "owner", createdBy: "owner" });
  assert.equal((await atLimit.post(photo("limit.png", "image/png", 10 * 1024 * 1024))).status, 200);
  assert.equal(atLimit.storageCalls[0].operation, "upload");
  assert.ok(atLimit.storageCalls[0].path.startsWith(`${hotelId}/work-orders/${workOrderId}/`));

  for (const [name, type] of [
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["photo.png", "image/png"],
    ["photo.gif", "image/gif"],
    ["photo.webp", "image/webp"],
    ["photo.bmp", "image/bmp"],
    ["photo.heic", "image/heic"],
    ["photo.heif", "image/heif"],
  ]) {
    const supported = fixture({ role: "Chief Engineer", userId: "owner", createdBy: "owner" });
    assert.equal((await supported.post(photo(name, type))).status, 200, `${name} upload`);
    assert.equal(supported.storageCalls[0].uploadOptions.contentType, type);
  }

  const cameraUpload = fixture({ role: "Chief Engineer", userId: "owner", createdBy: "owner" });
  const cameraResponse = await cameraUpload.post(photo("camera.jpg", ""));
  assert.equal(cameraResponse.status, 200, `MIME-less camera image: ${cameraResponse.body.error}`);

  const failedUpload = fixture({ role: "Chief Engineer", userId: "owner", createdBy: "owner", uploadError: true });
  assert.equal((await failedUpload.post(photo())).status, 503);
  assert.equal(failedUpload.logs.length, 1);
});

test("attachment retries reuse a validated upload ID without creating duplicate objects", async () => {
  const uploadId = "00000000-0000-4000-8000-000000000099";
  const route = fixture({ role: "Chief Engineer", userId: "owner", createdBy: "owner" });
  assert.equal((await route.post(photo(), uploadId)).status, 200);
  const uploaded = route.storageCalls[0];
  assert.equal(uploaded.path, `${hotelId}/work-orders/${workOrderId}/owner_${uploadId}.png`);
  assert.equal(uploaded.uploadOptions.upsert, true);

  const invalid = fixture({ role: "Chief Engineer", userId: "owner", createdBy: "owner" });
  assert.equal((await invalid.post(photo(), "not-a-uuid")).status, 400);
  assert.equal(invalid.storageCalls.length, 0);
});

test("Chief Engineer can read and upload attachments for closed work orders they did not create", async () => {
  const route = fixture({ role: "Chief Engineer", userId: "chief", createdBy: "owner", status: "Closed" });
  assert.equal((await route.get()).status, 200);
  assert.equal((await route.post(photo())).status, 200);
});

test("attachment listing returns signed image URLs and surfaces storage/signing failures", async () => {
  const route = fixture({
    role: "General Manager",
    files: [
      { name: "photo.png", created_at: "2026-10-09T14:00:00.000Z", metadata: { mimetype: "image/png" } },
      { name: "metadata.txt", metadata: { mimetype: "text/plain" } },
      { name: null, metadata: { mimetype: "image/png" } },
    ],
  });
  const response = await route.get();
  assert.equal(response.status, 200);
  assert.deepEqual(Array.from(response.body.images, ({ id, name, url }) => ({ id, name, url })), [{
    id: "photo.png",
    name: "photo.png",
    url: "http://local.invalid/signed-photo",
  }]);
  assert.equal(response.body.images[0].uploaded_at, "2026-10-09T14:00:00.000Z");
  assert.equal(response.headers["Cache-Control"], "private, no-store, max-age=0");
  assert.equal(route.storageCalls.filter(({ operation }) => operation === "sign").length, 1);

  const listFailure = fixture({ role: "Chief Engineer", listError: true });
  assert.equal((await listFailure.get()).status, 503);
  const signingFailure = fixture({ role: "Chief Engineer", signError: true });
  assert.equal((await signingFailure.get()).status, 503);
  assert.equal(signingFailure.logs.length, 1);
  const missingUrl = fixture({ role: "Chief Engineer", missingSignedUrl: true });
  assert.equal((await missingUrl.get()).status, 503);
});

test("attachment route intentionally exposes no delete handler", () => {
  assert.equal(routeSource.includes("export async function DELETE"), false);
  assert.equal(routeSource.includes("export async function POST"), true);
  assert.equal(routeSource.includes("export async function GET"), true);
});

test("work-order form accepts multiple gallery photos, camera photos, and previews them before submit", () => {
  assert.match(workOrderPageSource, /id="work-order-photo-file" type="file" accept="image\/\*" multiple/);
  assert.match(workOrderPageSource, /id="work-order-photo-camera" type="file" accept="image\/\*" capture="environment"/);
  assert.match(workOrderPageSource, /function WorkOrderPhotoPreview/);
  assert.match(workOrderPageSource, /photos\.map\(\(photo\) => <WorkOrderPhotoPreview/);
  assert.match(workOrderPageSource, /uploadWorkOrderAttachment\(workOrder\.id, selectedPhoto\.file, session\.access_token, selectedPhoto\.uploadId\)/);
  assert.match(workOrderPageSource, /uploadWorkOrderAttachment\(workOrder\.id, workOrder\.photo\.file, session\.access_token, workOrder\.photo\.uploadId\)/);
});

test("work-order detail exposes desktop photo upload and mobile camera controls to commenters", () => {
  const detailSource = readFileSync(new URL("../src/app/work-orders/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(detailSource, /canSubmitTicketNote && \([\s\S]*?id="work-order-detail-photo"[\s\S]*?accept="image\/\*"[\s\S]*?Upload photo/);
  assert.match(detailSource, /id="work-order-detail-camera"[\s\S]*?capture="environment"/);
  assert.match(detailSource, /className="[^"]*\bmd:hidden\b/);
  assert.match(detailSource, />\s*Camera\s*</);
  assert.match(detailSource, /onClick=\{\(\) => photoFileInputRef\.current\?\.click\(\)\}/);
});

test("a failed photo upload can be retried against the same created work order", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const file = new File([new Uint8Array([137, 80, 78, 71])], "retry.png", { type: "image/png" });

  try {
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1
        ? new Response(JSON.stringify({ error: "The work-order image could not be stored." }), { status: 503 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const failed = await uploadWorkOrderAttachment("work-order-123", file, "local-session-token", "00000000-0000-4000-8000-000000000099");
    assert.deepEqual(failed, { ok: false, message: "The work-order image could not be stored.", canReplace: false });

    const retried = await uploadWorkOrderAttachment("work-order-123", file, "local-session-token", "00000000-0000-4000-8000-000000000099");
    assert.deepEqual(retried, { ok: true });
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ url }) => url === "/api/work-orders/work-order-123/attachments"));
    assert.ok(requests.every(({ options }) => options.method === "POST"));
    assert.ok(requests.every(({ options }) => options.headers.Authorization === "Bearer local-session-token"));
    assert.ok(requests.every(({ options }) => options.headers["X-Upload-Id"] === "00000000-0000-4000-8000-000000000099"));
    for (const { options } of requests) {
      const uploadedFile = options.body.get("photo");
      assert.equal(uploadedFile.name, "retry.png");
      assert.deepEqual(Array.from(new Uint8Array(await uploadedFile.arrayBuffer())), [137, 80, 78, 71]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("photo upload network failures remain retryable and are reported", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      throw new TypeError("Storage service unavailable");
    };

    assert.deepEqual(
      await uploadWorkOrderAttachment("work-order-123", new File(["image"], "offline.png"), "local-session-token", "00000000-0000-4000-8000-000000000099"),
      { ok: false, message: "The photo upload could not be confirmed. Check the connection and retry.", canReplace: false },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("permanent file-validation failures let users replace the image without discarding the created work order", async () => {
  const originalFetch = globalThis.fetch;
  const file = new File(["invalid"], "too-large.png", { type: "image/png" });

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Images must be 10 MB or smaller." }), { status: 400 });
    assert.deepEqual(
      await uploadWorkOrderAttachment("work-order-123", file, "local-session-token", "00000000-0000-4000-8000-000000000099"),
      { ok: false, message: "Images must be 10 MB or smaller.", canReplace: true },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(workOrderPageSource, /canReplacePhoto && pendingPhotoUploads\.length > 0 && <><button[^>]*onClick=\{chooseReplacementPhoto\}[^>]*>Choose a different photo<\/button>/);
  assert.match(workOrderPageSource, /disabled=\{\(pendingPhotoUploads\.length > 0 && !canReplacePhoto\) \|\| retryingPhotoUpload\}/);
  assert.match(workOrderPageSource, /function chooseReplacementPhoto\(\)[\s\S]*?photoFileInputRef\.current\?\.click\(\)/);
  assert.match(workOrderPageSource, /function acceptSelectedPhotos\([\s\S]*?setPhotos\(\(current\) => current\.map\(\(photo\) => photo\.uploadId === photoToReplaceUploadId \? replacement : photo\)\)/);
  assert.match(workOrderPageSource, /onClick=\{continueWithoutPhoto\}[^>]*>Continue without photo<\/button>/);
  assert.match(workOrderPageSource, /function continueWithoutPhoto\(\)[\s\S]*?setPendingPhotoUploads\(\[\]\)[\s\S]*?setPhotos\(\[\]\)[\s\S]*?Photo upload was skipped[\s\S]*?resetWorkOrderForm\(true\)/);
  assert.match(workOrderPageSource, /\{pendingPhotoUploads\.length > 0 && !canReplacePhoto && <button[^>]*onClick=\{\(\) => void retryPendingPhotoUploads\(\)\}/);
});

test("attachment read errors are surfaced instead of appearing as an empty photo list", () => {
  assert.deepEqual(
    resolveWorkOrderImages(false, { error: "Storage is unavailable." }),
    { images: [], error: "Storage is unavailable." },
  );
});

test("a successful empty attachment response remains a valid empty state", () => {
  assert.deepEqual(resolveWorkOrderImages(true, { images: [] }), { images: [], error: "" });
});

test("attachment reads reject malformed response data", () => {
  assert.deepEqual(
    resolveWorkOrderImages(true, { images: [{ id: "photo-1", name: "photo.png" }] }),
    { images: [], error: "Work-order images returned an invalid response." },
  );
});

test("attachment reads preserve valid image metadata", () => {
  const image = { id: "photo-1", name: "photo.png", url: "http://127.0.0.1:55557/storage/signed" };
  assert.deepEqual(resolveWorkOrderImages(true, { images: [image] }), { images: [image], error: "" });
});

test("attachment reads preserve upload timestamps when present", () => {
  const image = {
    id: "photo-1",
    name: "photo.png",
    url: "http://127.0.0.1:55557/storage/signed",
    uploaded_at: "2026-10-09T14:00:00.000Z",
  };
  assert.deepEqual(resolveWorkOrderImages(true, { images: [image] }), { images: [image], error: "" });
});

for (const role of ["Lead Housekeeper", "Front Desk"]) {
  test(`${role} completes own pending photo upload with durable ticket association but no pending read access`, async (t) => {
    const db = new PGlite();
    const directory = await mkdtemp(join(tmpdir(), "cmpri-photo-fixture-"));
    const uploadId = "00000000-0000-4000-8000-000000000099";
    try {
      await db.exec("CREATE TABLE work_orders(id uuid, hotel_id uuid, created_by text, technician_name text, status text)");
      await db.query("INSERT INTO work_orders VALUES ($1,$2,$3,NULL,'Pending Verification')", [workOrderId, hotelId, "owner"]);
      const lookupWorkOrder = async filters => (await db.query("SELECT * FROM work_orders WHERE id=$1 AND hotel_id=$2", [filters.find(([key]) => key === "id")[1], filters.find(([key]) => key === "hotel_id")[1]])).rows[0] || null;
      const route = fixture({ role, userId: "owner", lookupWorkOrder, persistDirectory: directory });
      const methods = [];
      t.mock.method(globalThis, "fetch", async (url, init) => {
        assert.equal(url, `/api/work-orders/${workOrderId}/attachments`);
        assert.equal(init.headers.Authorization, "Bearer synthetic-token");
        methods.push(init.method);
        const result = await route.post(init.body.get("photo"), init.headers["X-Upload-Id"]);
        return new Response(JSON.stringify(result.body), {status: result.status});
      });
      const file = photo();
      assert.deepEqual(await uploadWorkOrderAttachment(workOrderId, file, "synthetic-token", uploadId), {ok: true});
      const relativePath = `${hotelId}/work-orders/${workOrderId}/owner_${uploadId}.png`;
      assert.deepEqual(await readFile(join(directory, relativePath)), Buffer.from(await file.arrayBuffer()));
      assert.equal((await db.query("SELECT status FROM work_orders WHERE id=$1", [workOrderId])).rows[0].status, "Pending Verification");
      assert.deepEqual(methods, ["POST"], "upload completion must not depend on forbidden GET readback");
      assert.equal((await route.get()).status, 403);
      assert.equal(route.storageCalls.filter(call => call.operation !== "upload").length, 0);
      assert.deepEqual(await uploadWorkOrderAttachment(workOrderId, file, "synthetic-token", uploadId), {ok: true});
      assert.equal((await readdir(dirname(join(directory, relativePath)))).length, 1, "retry keeps one associated object");
      const engineering = fixture({ role: "Chief Engineer", userId: "engineering-reader", lookupWorkOrder, persistDirectory: directory });
      const engineeringReadback = await engineering.get();
      assert.equal(engineeringReadback.status, 200);
      assert.equal(engineeringReadback.body.images.length, 1);
      assert.equal(engineering.storageCalls.find(call => call.operation === "sign").path, relativePath);
      await db.query("UPDATE work_orders SET status='Open' WHERE id=$1", [workOrderId]);
      const readback = await route.get();
      assert.equal(readback.status, 200);
      assert.equal(readback.body.images[0].id, `owner_${uploadId}.png`);
      assert.equal(route.storageCalls.find(call => call.operation === "sign").path, relativePath);
    } finally {
      await db.close(); await rm(directory, {recursive: true, force: true});
    }
  });

  test(`${role} pending uploads retain file validation and storage failure reporting`, async () => {
    const options = { role, userId: "owner", createdBy: "owner", status: "Pending Verification" };
    for (const file of [null, photo("notes.txt", "text/plain"), new File(["not an image"], "photo.png", { type: "image/png" }), photo("oversized.png", "image/png", 10 * 1024 * 1024 + 1)]) {
      const route = fixture(options);
      assert.equal((await route.post(file)).status, 400);
      assert.equal(route.storageCalls.length, 0);
    }
    const failedStorage = fixture({ ...options, uploadError: true });
    const result = await failedStorage.post(photo());
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "The work-order image could not be stored.");
  });

  test(`${role} pending exception rejects non-owner, other hotel, no submit capability and completed work`, async () => {
    for (const options of [
      {createdBy: "another-user", status: "Pending Verification"},
      {createdBy: null, status: "Pending Verification"},
      {workOrderHotelId: "00000000-0000-0000-0000-000000000099", status: "Pending Verification"},
      {membershipRole: "viewer", status: "Pending Verification"},
      ...["Completed", "Closed", "Will Not Do"].map(status => ({status})),
    ]) {
      const route = fixture({role, userId: "owner", createdBy: "owner", ...options});
      assert.ok([403,404].includes((await route.post(photo())).status), JSON.stringify(options));
      assert.ok([403,404].includes((await route.get()).status), JSON.stringify(options));
      assert.equal(route.storageCalls.length, 0);
    }
  });
}

test("pending upload exception does not include managers or technicians even on their own tickets", async () => {
  for (const role of ["General Manager", "Assistant General Manager", "Front Desk Manager", "Maintenance Technician"]) {
    const route=fixture({role,userId:"owner",createdBy:"owner",status:"Pending Verification"});
    assert.equal((await route.post(photo())).status,403,role);
    assert.equal((await route.get()).status,403,role);
    assert.equal(route.storageCalls.length,0);
  }
});

for (const { role } of roleCases) {
  test(`${role} attachment status and ownership permission matrix`, async () => {
    const engineering = ["Engineer", "Chief Engineer", "Engineering Manager", "Regional Maintenance", "System Administrator"].includes(role);
    const submitter = ["Front Desk", "Housekeeping", "Lead Housekeeper"].includes(role);
    for (const status of ["Pending Verification", "Open", "In Progress", "Completed", "Closed", "Will Not Do"]) {
      for (const own of [true, false]) {
        const route = fixture({role, status, userId: "actor", createdBy: own ? "actor" : "other"});
        const generallyAllowed = engineering || ["Open", "In Progress"].includes(status);
        assert.equal((await route.get()).status, generallyAllowed ? 200 : 403, `${status} read own=${own}`);
        assert.equal((await route.post(photo())).status, generallyAllowed || (submitter && own && status === "Pending Verification") ? 200 : 403, `${status} write own=${own}`);
      }
    }
  });
}


test("different commenters cannot overwrite each other's upload keys", async () => {
  const uploadId = "00000000-0000-4000-8000-000000000099";
  const paths=[];
  for(const userId of ["actor-a","actor-b"]) {
    const f=fixture({role:"Maintenance Technician",userId,technicianName:"Other Technician"});
    assert.equal((await f.post(photo(),uploadId)).status,200);
    paths.push(f.storageCalls[0].path);
    assert.equal(f.storageCalls[0].uploadOptions.metadata.uploaded_by,userId);
  }
  assert.notEqual(paths[0],paths[1]);
});
