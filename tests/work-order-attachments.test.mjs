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
  let authCalls = 0;
  const logs = [];
  const objects = options.objects || new Map();
  const missing = { statusCode: "404", code: "NoSuchKey" };
  async function stored(path) {
    if (objects.has(path)) return objects.get(path);
    if (options.persistDirectory) {
      try { return new Blob([await readFile(join(options.persistDirectory, path))], { type: "image/png" }); } catch { return null; }
    }
    return null;
  }
  async function storeObject(path, file, type = file.type) {
    if (await stored(path)) return { error: { statusCode: "409" } };
    const bytes = await file.arrayBuffer();
    if (objects.has(path)) return { error: { statusCode: "409" } };
    objects.set(path, new Blob([bytes], { type }));
    if (options.persistDirectory) {
      const target = join(options.persistDirectory, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(await file.arrayBuffer()));
    }
    return { error: null };
  }
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
    profile: { id: userId, email: options.email, role, secondary_roles: options.secondaryRoles || [], full_name: options.fullName || "Test User", active: true },
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
          info: async (path) => {
            storageCalls.push({ operation: "info", path });
            if (options.infoError) return { data: null, error: { statusCode: "503" } };
            const file = await stored(path);
            return file ? { data: { size: file.size, contentType: file.type }, error: null } : { data: null, error: missing };
          },
          download: async (path) => { const file = await stored(path); return { data: file, error: file ? null : missing }; },
          createSignedUploadUrl: async (path, settings) => {
            storageCalls.push({ operation: "sign-upload", path, settings });
            assert.equal(settings.upsert, false);
            return { data: { signedUrl: `https://storage.invalid/upload?path=${encodeURIComponent(path)}&token=synthetic` }, error: null };
          },
          remove: async (paths) => {
            storageCalls.push({ operation: "remove", paths });
            if (!options.removeError) for (const path of paths) {
              objects.delete(path);
              if (options.persistDirectory) await rm(join(options.persistDirectory, path), { force: true });
            }
            return { error: options.removeError ? new Error("storage unavailable") : null };
          },
          upload: async (path, file, uploadOptions) => {
            storageCalls.push({ operation: "upload", path, file, uploadOptions });
            if (options.uploadError) return { error: new Error("storage unavailable") };
            return storeObject(path, file, uploadOptions.contentType);
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
      if (name === "@/lib/server/auth") return { requireUser: async () => options.authenticated === false || ++authCalls === options.revokeOnAuthCall ? null : { principal, admin } };
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
    objects,
    direct: async (url, file) => storeObject(new URL(url).searchParams.get("path"), file),
    put: (body, id = workOrderId) => exports.PUT({ text: async () => JSON.stringify(body) }, { params: Promise.resolve({ id }) }),
    filters,
    storageCalls,
    logs,
    remove: (photoId, id = workOrderId) => exports.DELETE({json: async () => ({photoId})}, {params: Promise.resolve({id})}),
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
  assert.equal(uploaded.uploadOptions.upsert, false);

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

test("attachment route exposes authenticated removal alongside read and upload", () => {
  assert.equal(routeSource.includes("export async function DELETE"), true);
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
  assert.match(detailSource, /canSubmitTicketNote && \([\s\S]*?id="work-order-detail-photo"[\s\S]*?accept="image\/\*"[\s\S]*?Choose photo/);
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
        : new Response(JSON.stringify({ ok: true, complete: true }), { status: 200 });
    };

    const failed = await uploadWorkOrderAttachment("work-order-123", file, "local-session-token", "00000000-0000-4000-8000-000000000099");
    assert.deepEqual(failed, { ok: false, message: "The work-order image could not be stored.", canReplace: false });

    const retried = await uploadWorkOrderAttachment("work-order-123", file, "local-session-token", "00000000-0000-4000-8000-000000000099");
    assert.deepEqual(retried, { ok: true });
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ url }) => url === "/api/work-orders/work-order-123/attachments"));
    assert.ok(requests.every(({ options }) => options.method === "PUT"));
    assert.ok(requests.every(({ options }) => options.headers.Authorization === "Bearer local-session-token"));
    for (const { options } of requests) {
      const descriptor = JSON.parse(options.body);
      assert.equal(descriptor.uploadId, "00000000-0000-4000-8000-000000000099");
      assert.equal(descriptor.size, file.size);
      assert.equal(descriptor.action, "prepare");
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
        if (String(url).startsWith("https://storage.invalid/")) {
          assert.equal(init.headers.Authorization, undefined);
          const result = await route.direct(url, init.body);
          return new Response("{}", { status: result.error ? 409 : 200 });
        }
        assert.equal(url, `/api/work-orders/${workOrderId}/attachments`);
        assert.equal(init.headers.Authorization, "Bearer synthetic-token");
        methods.push(init.method);
        const result = await route.put(JSON.parse(init.body));
        return new Response(JSON.stringify(result.body), { status: result.status });
      });
      const file = photo();
      assert.deepEqual(await uploadWorkOrderAttachment(workOrderId, file, "synthetic-token", uploadId), {ok: true});
      const relativePath = `${hotelId}/work-orders/${workOrderId}/owner_${uploadId}.png`;
      assert.deepEqual(await readFile(join(directory, relativePath)), Buffer.from(await file.arrayBuffer()));
      assert.equal((await db.query("SELECT status FROM work_orders WHERE id=$1", [workOrderId])).rows[0].status, "Pending Verification");
      assert.deepEqual(methods, ["PUT", "PUT"], "upload completion must not depend on forbidden GET readback");
      assert.equal((await route.get()).status, 403);
      assert.equal(route.storageCalls.filter(call => ["list", "sign"].includes(call.operation)).length, 0);
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

const photoOwner = '750f77bf-7d5d-4ca6-8421-e025edea87ba';
const ownPhoto = photoOwner + '_00000000-0000-4000-8000-000000000099.png';
test('Chief Engineer removal targets a selected saved photo inside the exact hotel/ticket prefix', async () => {
 const route=fixture({role:'Chief Engineer',userId:photoOwner});
 assert.equal((await route.remove(ownPhoto)).status,200);
 assert.deepEqual(Array.from(route.storageCalls[0].paths),[hotelId+'/work-orders/'+workOrderId+'/'+ownPhoto]);
 assert.ok(route.filters.some(([k,v])=>k==='hotel_id'&&v===hotelId));
});
test('removal rejects paths, encoded traversal and malformed bodies',async()=>{
 for(const name of ['../'+ownPhoto,ownPhoto+'/x','%2e%2e%2f'+ownPhoto,ownPhoto.replace('.png','.pdf'),null,{},'']){
  const route=fixture({role:'Chief Engineer',userId:photoOwner});assert.equal((await route.remove(name)).status,403);assert.equal(route.storageCalls.length,0);
 }
});
test('removal enforces sign-in, lookup errors, hotel scope and valid ticket IDs',async()=>{
 for(const [options,status] of [[{authenticated:false},401],[{lookupError:true},503],[{workOrderHotelId:'other'},404]]){
  const route=fixture({role:'Chief Engineer',userId:photoOwner,...options});assert.equal((await route.remove(ownPhoto)).status,status);assert.equal(route.storageCalls.length,0);
 }
 const route=fixture({userId:photoOwner});assert.equal((await route.remove(ownPhoto,'bad-id')).status,400);assert.equal(route.storageCalls.length,0);
});
test('only Chief Engineer can remove saved photos regardless of uploader, creator or ordinary edit capability',async()=>{
 for(const {role} of roleCases)for(const status of ['Open','In Progress','Closed','Pending Verification'])for(const ownTicket of [true,false]){
  const options={role,status,userId:photoOwner,createdBy:ownTicket?photoOwner:'other',technicianName:'Another Technician'};
  const remove=fixture(options);
  assert.equal((await remove.remove(ownPhoto)).status,role === 'Chief Engineer' ? 200 : 403,role+' '+status+' creator='+ownTicket);
 }
});
test('storage removal failures remain visible and do not report success',async()=>{
 const route=fixture({role:'Chief Engineer',userId:photoOwner,removeError:true});const response=await route.remove(ownPhoto);assert.equal(response.status,503);assert.match(response.body.error,/could not be removed/);
});
test('listing advertises removal only for Chief Engineer and valid photo keys',async()=>{
 const route=fixture({role:'Chief Engineer',userId:photoOwner,files:[{name:ownPhoto,metadata:{mimetype:'image/png'}},{name:'legacy.png',metadata:{mimetype:'image/png'}}]});
 const result=await route.get();assert.equal(result.body.images[0].can_remove,true);assert.equal(result.body.images[1].can_remove,false);
 assert.equal(resolveWorkOrderImages(true,{images:[{id:ownPhoto,name:ownPhoto,url:'https://example.invalid/photo',can_remove:true}]}).images[0].can_remove,true);
});

test('Chief Engineer can delete other uploaders and legacy saved images; submitters cannot delete their own',async()=>{
 for(const key of ['00000000-0000-4000-8000-000000000098_00000000-0000-4000-8000-000000000099.png','00000000-0000-4000-8000-000000000099.png']){
 const chief=fixture({role:'Chief Engineer',userId:photoOwner});assert.equal((await chief.remove(key)).status,200);
 }
 for(const role of ['Front Desk','Technician','Maintenance Technician','System Administrator','Engineer','Engineering Manager','Regional Maintenance','Regional Engineer']){
 const route=fixture({role,userId:photoOwner,createdBy:photoOwner});assert.equal((await route.remove(ownPhoto)).status,403);assert.equal(route.storageCalls.length,0);
 const read=fixture({role,userId:photoOwner,files:[{name:ownPhoto,metadata:{mimetype:'image/png'}}]});const result=await read.get();if(result.status===200)assert.equal(result.body.images[0].can_remove,false);
 }
});

test('every recognized submission role/alias follows upload status policy, including all currently active profile shapes', async () => {
 const roleText=readFileSync(new URL('../src/lib/server/roles.ts',import.meta.url),'utf8');
 const aliasBlock=roleText.match(/const aliases:[\s\S]*?= \{([\s\S]*?)\n\};/)[1];
 const aliases=[...aliasBlock.matchAll(/([a-z]+): "([a-z_]+)"/g)].map(m=>({role:m[1],family:m[2]}));
 const inventory=[{role:'assistant_manager',membershipRole:'technician'},{role:'front_desk',membershipRole:'technician'},{role:'front_desk_manager',membershipRole:'technician'},{role:'system_admin',membershipRole:'admin'},{role:'system_admin',secondaryRoles:['engineer'],membershipRole:'admin'}];
 const results=[];
 for(const options of [...aliases,...inventory]){
  const family=roleModule.roleKey(options.role);
  const canSubmit=roleModule.profileAllows({role:options.role,secondary_roles:options.secondaryRoles||[]},'submit')&&roleModule.membershipAllows(options.membershipRole||roleModule.membershipRole(options.role),'submit');
  const technical=['engineer','system_admin'].includes(family);
  const submitOnly=['front_desk','housekeeping'].includes(family);
  const outcomes={};
  for(const status of ['Pending Verification','Open','In Progress','Completed','Closed','Will Not Do'])for(const owner of [true,false]){
   const route=fixture({...options,status,userId:'actor',createdBy:owner?'actor':'other'});
   const expected=technical||['Open','In Progress'].includes(status)||(submitOnly&&owner&&status==='Pending Verification');
   const response=await route.post(photo());assert.equal(response.status,expected?200:403,options.role+' '+status+' own='+owner);
   outcomes[status+(owner?' own':' other')]=response.status;
  }
  results.push({role:options.role,secondaryRoles:options.secondaryRoles||[],family,canSubmit,outcomes});
 }
 await writeFile(new URL('../../upload-role-matrix.json',import.meta.url),JSON.stringify({kind:'offline real route / mocked auth and storage',results},null,2));
});

test('effective Chief mapping includes Scott exactly and excludes lookalike admin/engineer combinations',async()=>{
 const scott={userId:photoOwner,email:'maint.cmpri@hawkeyehotels.com',role:'system_admin',secondaryRoles:['engineer']};
 const cases=[{...scott,allowed:true},{...scott,userId:'00000000-0000-4000-8000-000000000098'},{...scott,email:'other@example.invalid'},{...scott,secondaryRoles:[]},{...scott,role:'Engineer'},{...scott,secondaryRoles:['Regional Engineer']},{userId:photoOwner,role:'Chief Engineer',allowed:true},{userId:photoOwner,role:'system_admin',secondaryRoles:['Chief Engineer'],allowed:true}];
 for(const item of cases){const route=fixture({...item,files:[{name:ownPhoto,metadata:{mimetype:'image/png'}}]});assert.equal((await route.remove(ownPhoto)).status,item.allowed?200:403,JSON.stringify(item));const read=await route.get();assert.equal(read.body.images[0].can_remove,Boolean(item.allowed));}
});

const directUploadId = "11111111-1111-4111-8111-111111111111";
async function description(file, action = "prepare", uploadId = directUploadId) {
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())).toString("hex");
  return { action, uploadId, name: file.name, type: file.type, size: file.size, sha256 };
}
function wireDirectClient(t, route, options = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    if (String(url).startsWith("https://storage.invalid/")) {
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.credentials, "omit");
      assert.equal(init.referrerPolicy, "no-referrer");
      assert.equal(init.headers["x-upsert"], "false");
      if (options.interruptBeforeStorage) throw new Error("offline");
      const result = await route.direct(url, init.body);
      if (options.loseStorageResponse) throw new Error("response lost");
      return new Response("{}", { status: result.error ? 409 : 200 });
    }
    assert.equal(url, `/api/work-orders/${workOrderId}/attachments`);
    assert.equal(init.method, "PUT");
    assert.ok(Buffer.byteLength(init.body) < 2048, "No image payload passes through the function");
    const body = JSON.parse(init.body);
    const response = await route.put(body);
    if (options.loseFinalizeResponse && body.action === "finalize") throw new Error("response lost");
    return new Response(JSON.stringify(response.body), { status: response.status });
  });
  return calls;
}

test("direct original-byte transfer crosses 4.5 MB, includes Scott's 6.71 MB, and accepts inclusive 10 MiB", async t => {
  for (const size of [4_499_999, 4_500_001, 6_710_000, Math.round(6.71 * 1024 * 1024), 10 * 1024 * 1024 - 1, 10 * 1024 * 1024]) {
    const route = fixture({ role: "Front Desk Manager", userId: "owner", createdBy: "owner", membershipRole: "technician" });
    const calls = wireDirectClient(t, route);
    const file = photo("original.jpg", "image/jpeg", size);
    assert.deepEqual(await uploadWorkOrderAttachment(workOrderId, file, "synthetic", directUploadId), { ok: true });
    const saved = route.objects.get(`${hotelId}/work-orders/${workOrderId}/owner_${directUploadId}.jpg`);
    assert.equal(saved.size, size);
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), Buffer.from(await file.arrayBuffer()));
    assert.equal(calls.filter(c => String(c.url).startsWith("https://storage.invalid/")).length, 1);
    assert.equal(route.objects.size, 1, "verified original saved once; staging cleaned");
    assert.equal(route.logs.length, 0);
  }
});

test("client and server independently reject over 10 MiB; forged size/type/signature/hash never becomes a ticket photo", async t => {
  const route = fixture({ role: "Front Desk Manager", userId: "owner", createdBy: "owner" });
  const calls = wireDirectClient(t, route);
  const over = photo("over.jpg", "image/jpeg", 10 * 1024 * 1024 + 1);
  assert.equal((await uploadWorkOrderAttachment(workOrderId, over, "synthetic", directUploadId)).canReplace, true);
  assert.equal(calls.length, 0);
  assert.equal((await route.put(await description(over))).status, 400);
  for (const mismatch of ["size", "mime", "signature", "hash"]) {
    const r = fixture({ role: "Chief Engineer", userId: "owner", createdBy: "owner" });
    const file = photo();
    const body = await description(file);
    const prepared = await r.put(body);
    let actual = file;
    if (mismatch === "size") actual = photo("photo.png", "image/png", 10 * 1024 * 1024 + 1);
    if (mismatch === "mime") actual = new File([await file.arrayBuffer()], "photo.png", { type: "application/pdf" });
    if (mismatch === "signature") {
      actual = new File([new Uint8Array(16)], "photo.png", { type: "image/png" });
      Object.assign(body, await description(actual));
      const changed = await r.put(body);
      prepared.body.signedUrl = changed.body.signedUrl;
    }
    if (mismatch === "hash") { const bytes = new Uint8Array(await file.arrayBuffer()); bytes[15] = 1; actual = new File([bytes], "photo.png", { type: "image/png" }); }
    await r.direct(prepared.body.signedUrl, actual);
    const result = await r.put({ ...body, action: "finalize" });
    assert.equal(result.status, 400, mismatch);
    assert.equal([...r.objects.keys()].filter(path => path.includes("/work-orders/")).length, 0);
  }
});

test("signed staging preserves same role, hotel, ticket and current session gates at prepare and finalize", async () => {
  const file = photo(); const body = await description(file);
  for (const options of [
    { authenticated: false },
    { workOrderHotelId: "other-hotel" },
    { role: "Front Desk Manager", status: "Closed", createdBy: "other" },
    { role: "Front Desk", status: "Pending Verification", createdBy: "other" },
  ]) {
    const route = fixture(options);
    assert.ok([401, 403, 404].includes((await route.put(body)).status));
    assert.ok([401, 403, 404].includes((await route.put({ ...body, action: "finalize" })).status));
    assert.equal(route.storageCalls.length, 0);
  }
  const settings = { role: "Front Desk Manager", userId: "owner", createdBy: "owner" };
  const route = fixture(settings);
  const prepared = await route.put(body);
  await route.direct(prepared.body.signedUrl, file);
  settings.authenticated = false;
  assert.equal((await route.put({ ...body, action: "finalize" })).status, 401);
  assert.equal([...route.objects.keys()].filter(path => path.includes("/work-orders/")).length, 0);
  settings.authenticated = true;
  assert.equal((await route.put({ ...body, path: "other-ticket", action: "finalize" })).status, 400);
  // Same readable ticket, different actor cannot finalize someone else's staging object.
  const other = fixture({ role: "Chief Engineer", userId: "other", objects: route.objects });
  assert.equal((await other.put({ ...body, action: "finalize" })).status, 409);
  const anotherTicket = "22222222-2222-4222-8222-222222222222";
  assert.equal((await route.put({ ...body, action: "finalize" }, anotherTicket)).status, 409);
});

test("interruptions, lost responses, and concurrent finalization preserve one immutable photo and never create tickets", async t => {
  const file = photo("phone.jpg", "image/jpeg", 6_710_000);
  const route = fixture({ role: "Front Desk Manager", userId: "owner", createdBy: "owner" });
  wireDirectClient(t, route, { interruptBeforeStorage: true });
  assert.equal((await uploadWorkOrderAttachment(workOrderId, file, "synthetic", directUploadId)).ok, false);
  wireDirectClient(t, route, { loseStorageResponse: true, loseFinalizeResponse: true });
  assert.equal((await uploadWorkOrderAttachment(workOrderId, file, "synthetic", directUploadId)).ok, false);
  const retryCalls = wireDirectClient(t, route);
  assert.deepEqual(await uploadWorkOrderAttachment(workOrderId, file, "synthetic", directUploadId), { ok: true });
  assert.equal(retryCalls.length, 1, "lost final response uses verified existing object");
  assert.equal(route.objects.size, 1);
  const body = await description(file);
  const results = await Promise.all([route.put({ ...body, action: "finalize" }), route.put({ ...body, action: "finalize" })]);
  assert.ok(results.every(r => r.body.complete));
  const changed = photo("phone.jpg", "image/jpeg", 20);
  assert.equal((await route.put(await description(changed))).status, 400, "same upload ID cannot overwrite saved photo");
  assert.equal(route.objects.size, 1);
});

test("staged bytes remain invisible until validation; finalization failure retries without a second storage transfer", async t => {
  const settings = { role: "Front Desk", userId: "owner", createdBy: "owner", status: "Pending Verification", uploadError: true };
  const route = fixture(settings); const file = photo();
  wireDirectClient(t, route);
  assert.equal((await uploadWorkOrderAttachment(workOrderId, file, "synthetic", directUploadId)).ok, false);
  assert.ok([...route.objects.keys()].every(path => path.includes("/work-order-upload-staging/")));
  assert.equal((await route.get()).status, 403);
  settings.uploadError = false;
  const calls = wireDirectClient(t, route);
  assert.deepEqual(await uploadWorkOrderAttachment(workOrderId, file, "synthetic", directUploadId), { ok: true });
  assert.equal(calls.length, 2, "prepare discovers staged bytes, finalize saves them");
});

test("revocation during final verification prevents promotion; concurrent first finalizations never overwrite", async () => {
  const file = photo(); const body = await description(file);
  const revoked = fixture({ role: "Front Desk Manager", userId: "owner", createdBy: "owner", revokeOnAuthCall: 3 });
  const prepared = await revoked.put(body);
  await revoked.direct(prepared.body.signedUrl, file);
  assert.equal((await revoked.put({ ...body, action: "finalize" })).status, 401);
  assert.ok([...revoked.objects.keys()].every(path => path.includes("/work-order-upload-staging/")));
  const route = fixture({ role: "Front Desk Manager", userId: "owner", createdBy: "owner" });
  await route.direct((await route.put(body)).body.signedUrl, file);
  const results = await Promise.all([route.put({ ...body, action: "finalize" }), route.put({ ...body, action: "finalize" })]);
  assert.ok(results.every(result => result.body.complete));
  assert.equal(route.objects.size, 1);
  assert.ok(route.storageCalls.filter(call => call.operation === "upload").every(call => call.uploadOptions.upsert === false));
});

test("staging outage and cleanup failure cannot expose tokens or erase a saved photo; legacy retry cannot overwrite", async () => {
  const file = photo(); const body = await description(file);
  const outage = fixture({ role: "Chief Engineer", infoError: true });
  assert.equal((await outage.put(body)).status, 503);
  assert.equal(outage.storageCalls.some(call => call.operation === "sign-upload"), false);
  assert.equal(outage.logs.length, 0);
  const route = fixture({ role: "Chief Engineer", userId: "owner", createdBy: "owner", removeError: true });
  await route.direct((await route.put(body)).body.signedUrl, file);
  assert.equal((await route.put({ ...body, action: "finalize" })).body.complete, true);
  assert.ok(route.storageCalls.filter(call => call.operation === "remove").every(call => call.paths.every(path => path.includes("/work-order-upload-staging/"))));
  assert.equal((await route.post(photo("photo.png", "image/png", 17), directUploadId)).status, 503);
  assert.equal(route.objects.get(`${hotelId}/work-orders/${workOrderId}/owner_${directUploadId}.png`).size, file.size);
});
