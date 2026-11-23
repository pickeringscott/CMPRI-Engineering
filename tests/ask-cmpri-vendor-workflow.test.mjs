import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { loadTs } from "./helpers/load-ts.mjs";

class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
const applicability = loadTs("src/lib/manual-applicability.ts");
const matching = loadTs("src/lib/manual-document-match.ts");
const pdf = loadTs("src/lib/manual-pdf-knowledge.ts", { "@/lib/manual-document-match": matching });
const reviews = loadTs("src/lib/stored-pdf-link.ts");
const suggestions = loadTs("src/lib/equipment-pdf-suggestions.ts");
const assetId = "384cb0f6-160b-4dc7-bbaf-11faed846157";
const fileId = "314dc254-9b39-4cfb-9d14-d06ee001b64d";
const hotelId = "fcaee601-fac8-43a9-b5d1-107f433dbd15";
const request = body => new NextRequest("https://cmpri.test/api/ask-cmpri/vendor-import", {
  method: "POST", headers: { Authorization: "Bearer native-user-session", "Content-Type": "application/json", "x-cmpri-property": "current-property" }, body: JSON.stringify(body),
});

function fixture() {
  const calls = [];
  const bytes = new TextEncoder().encode("%PDF-1.7 actual fixture original bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const asset = { id: assetId, hotel_id: hotelId, active: true, asset_type: "PTAC", name: "Guestroom PTAC",
    manufacturer: "Actual Manufacturer", model_number: "MODEL-42", model_family: "", serial_number: "125",
    updated_at: "2026-11-23T08:00:00.000Z", documentation_verified_at: null, documentation_revision_id: null, pdf_import_links: [] };
  const evidence = { asset, auth: {}, bytes, sha256, text: "Manufacturer: Actual Manufacturer\nModel: MODEL-42\nTroubleshooting: Check the supply.",
    descriptor: { kind: "asset-documentation", id: fileId, name: "service-manual.pdf", size: bytes.length, sha256 }, sourceUrl: "https://vendor.example/manual.pdf", fileName: "service-manual.pdf",
    identityMatch: true, review: { complete: true, intended: "verify", serial: { status: "unrestricted" } } };
  const file = { object_id: fileId, storage_path: `${hotelId}/${assetId}/${fileId}-service-manual.pdf`, size: bytes.length, title: "service-manual.pdf", catalog_status: "not_cataloged" };
  const state = { files: [], links: [], revision: 0, locked: false, deniedRead: false, deniedWrite: false, failSave: false, failUpload: false,
    guide: "ready", mismatch: false, changedIdentity: false, malformedRevision: false };
  const timestamp = () => `2026-11-23T08:00:0${state.revision}.000Z`;
  const identity = () => ({ ...applicability.manualAssetIdentity(asset), ...(state.changedIdentity ? { model_number: "CHANGED" } : {}) });
  const auth = incoming => {
    assert.equal(incoming.headers.get("authorization"), "Bearer native-user-session");
    assert.equal(incoming.headers.get("x-cmpri-property"), "current-property");
  };
  const inspected = () => ({ file: { ...file, catalog_status: state.mismatch ? "content_mismatch" : file.catalog_status }, sha256,
    asset_identity: identity(), updated_at: timestamp(), readable_text: true });
  const workflow = loadTs("src/lib/server/ask-cmpri-vendor-workflow.ts", {
    "server-only": {}, "next/server": { NextRequest }, "@/lib/manual-applicability": applicability,
    "@/lib/manual-document-match": matching, "@/lib/manual-pdf-knowledge": pdf,
    "@/lib/stored-pdf-link": reviews, "@/lib/equipment-pdf-suggestions": suggestions,
    "@/lib/server/ask-cmpri-vendor-document": { readAskVendorEvidence: async (incoming, token) => {
      auth(incoming); assert.equal(token, "reviewed-token");
      return { ...evidence, asset: { ...asset, updated_at: timestamp(), documentation_verified_at: state.locked ? timestamp() : null } };
    } },
    "@/app/api/assets/documentation/route": {
      GET: async incoming => {
        auth(incoming); calls.push({ action: "stored-read" });
        return state.deniedRead ? Response.json({ error: "Native equipment role denied" }, { status: 403 })
          : Response.json({ files: state.files, links: state.links, asset_identity: identity(), updated_at: timestamp() });
      },
      POST: async incoming => {
        auth(incoming); const form = await incoming.formData(); const action = form.get("import_action");
        assert.equal(form.get("asset_id"), assetId);
        calls.push({ action, form });
        if (state.deniedWrite) return Response.json({ error: "Native equipment role denied" }, { status: 403 });
        if (action === "upload") {
          const uploaded = form.get("file"); assert.ok(uploaded instanceof File);
          assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), bytes);
          state.files.push(file);
          if (state.failUpload) return Response.json({ error: "Original uploaded, but it could not be opened for review. Reload stored PDFs; do not upload a second copy.", storage_path: file.storage_path }, { status: 503 });
          return Response.json(inspected());
        }
        if (action === "review") { assert.equal(form.get("object_id"), fileId); return Response.json(inspected()); }
        assert.equal(action, "save"); assert.equal(form.get("object_id"), fileId); assert.equal(form.get("sha256"), sha256);
        assert.equal(form.get("expected_updated_at"), timestamp()); assert.equal(form.get("review_confirmed"), "true");
        if (state.failSave) return Response.json({ error: "Association could not be read back" }, { status: 503 });
        const fields = JSON.parse(form.get("fields"));
        state.links = [{ ...file, ...fields, sha256 }]; state.revision++;
        return Response.json({ saved: state.links[0], association_verified: true, updated_at: timestamp() });
      },
    },
    "@/app/api/assets/route": { PATCH: async incoming => {
      auth(incoming); const body = await incoming.json(); assert.equal(body.expected_updated_at, timestamp());
      calls.push({ action: body.begin_documentation_revision ? "revision" : "verify", body });
      if (body.begin_documentation_revision) {
        state.revision++; state.locked = false;
        return Response.json(state.malformedRevision ? {} : { revision_open: true, revision_id: assetId });
      }
      assert.equal(body.verify_with_documentation, true); state.revision++; state.locked = true;
      return Response.json({ verified: true });
    } },
    "@/app/api/maintenance-reference/route": { GET: async incoming => {
      auth(incoming); calls.push({ action: "guide" });
      assert.equal(incoming.nextUrl.searchParams.get("assetId"), assetId);
      if (state.guide === "denied") return Response.json({ error: "Native guide role denied" }, { status: 403 });
      const original = { registered_file_id: fileId, sha256, search_incomplete: state.guide === "pending" };
      const source = state.guide === "other" ? { registered_file_id: assetId, sha256: "a".repeat(64) } : original;
      return Response.json({ documentation_status: "verified", documentation_reason: "Native source readback", documentation_warnings: [],
        manualKnowledge: { sources: [source], source, source_passages: state.guide === "no_guidance" ? [] : [
          { source_document_id: source.registered_file_id, source_sha256: source.sha256, kind: "procedure", text: "Actual source procedure" },
        ] } });
    } },
  }, { Request, Response, Headers, FormData, File, URL, Uint8Array, TextEncoder, Error });
  const run = async body => { const response = await workflow.importAskVendorDocument(request({ documentToken: "reviewed-token", ...body })); return { status: response.status, data: await response.json() }; };
  return { run, state, evidence, file, calls };
}

test("confirmed vendor import uploads exact bytes and uses native current revisions and applicability", async () => {
  const f = fixture(); const result = await f.run({ verify: true });
  assert.equal(result.status, 200); assert.equal(result.data.verified, true); assert.equal(result.data.troubleshooting.status, "ready");
  assert.match(result.data.message, /exact original/); assert.equal(result.data.file_id, fileId);
  const fields = JSON.parse(f.calls.find(call => call.action === "save").form.get("fields"));
  assert.equal(fields.applicability, "confirmed_model"); assert.equal(fields.selected_model, "MODEL-42");
  assert.equal(fields.applicability_review.asset_id, assetId); assert.equal(fields.applicability_review.confirmed, true);
  assert.equal(fields.preferred, false); assert.equal(fields.quarantine_acknowledged, false);
  assert.deepEqual(f.calls.filter(call => ["upload", "save", "verify", "guide"].includes(call.action)).map(call => call.action), ["upload", "save", "verify", "guide"]);
});

test("reference-only tokens cannot escalate and incomplete identity or serial evidence blocks all writes", async () => {
  for (const change of [
    evidence => evidence.review.intended = "reference",
    evidence => evidence.review.complete = false,
    evidence => evidence.text = "Different Manufacturer MODEL-42",
    evidence => evidence.review.serial = { status: "unresolved" },
    evidence => evidence.review.serial = { status: "range", range: { kind: "numeric", from: "200", to: "299" } },
  ]) {
    const f = fixture(); change(f.evidence); const result = await f.run({ verify: true });
    assert.equal(result.status, 409); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.evidence.review.serial = { status: "range", range: { kind: "numeric", from: "100", to: "199" } };
  assert.equal((await f.run({ verify: true })).status, 200);
  assert.deepEqual(f.state.links[0].serial_range, { kind: "numeric", from: "100", to: "199" });
});

test("reference imports never invent verified applicability or call final asset verification", async () => {
  const f = fixture(); f.evidence.review.complete = false; f.evidence.identityMatch = false; f.evidence.review.intended = "reference";
  const result = await f.run({});
  assert.equal(result.status, 200); assert.equal(result.data.applicability, "reference"); assert.equal(result.data.verified, false);
  assert.equal(result.data.troubleshooting.status, "reference"); assert.ok(!f.calls.some(call => call.action === "verify"));
  assert.equal(f.state.links[0].applicability_review, null); assert.equal(f.state.links[0].selected_model, "");
});

test("locked equipment needs an explicit reason and uses the actual opened revision", async () => {
  const f = fixture(); f.state.locked = true;
  assert.equal((await f.run({ verify: true })).status, 409); assert.deepEqual(f.calls.map(call => call.action), ["stored-read"]);
  const result = await f.run({ verify: true, revisionReason: "Replace the damaged manual with its readable original." });
  assert.equal(result.status, 200); assert.equal(result.data.progress.revision_opened, true);
  assert.equal(f.calls.find(call => call.action === "revision").body.revision_reason, "Replace the damaged manual with its readable original.");
  assert.ok(f.calls.findIndex(call => call.action === "revision") < f.calls.findIndex(call => call.action === "upload"));
});

test("native permission denials and changed identities stop without bypasses", async () => {
  const denied = fixture(); denied.state.deniedRead = true;
  assert.equal((await denied.run({ verify: true })).status, 403); assert.equal(denied.calls.length, 1);
  const changed = fixture(); changed.state.changedIdentity = true;
  assert.equal((await changed.run({ verify: true })).status, 409); assert.equal(changed.calls.length, 1);
  const writeDenied = fixture(); writeDenied.state.deniedWrite = true;
  const result = await writeDenied.run({ verify: true }); assert.equal(result.status, 403); assert.equal(result.data.progress.uncertain_step, null);
  assert.equal(writeDenied.state.files.length, 0);
});

test("a new proposal after a failed association reuses the unassociated original instead of uploading again", async () => {
  const f = fixture(); f.state.failSave = true;
  const failed = await f.run({ verify: true });
  assert.equal(failed.status, 409); assert.equal(failed.data.progress.original_uploaded, true);
  assert.match(failed.data.error, /original PDF was uploaded/); assert.match(failed.data.error, /Reload the asset and stored PDFs/);
  f.state.failSave = false;
  const recovered = await f.run({ verify: true });
  assert.equal(recovered.status, 200); assert.equal(recovered.data.progress.original_reused, true);
  assert.equal(f.calls.filter(call => call.action === "upload").length, 1); assert.equal(f.calls.filter(call => call.action === "review").length, 1);
});

test("upload and malformed revision failures retain concrete recovery state", async () => {
  const f = fixture(); f.state.failUpload = true;
  const failed = await f.run({ verify: true });
  assert.equal(failed.status, 409); assert.equal(failed.data.original_storage_path, f.file.storage_path);
  assert.match(failed.data.error, /do not upload a second copy/); assert.match(failed.data.progress.uncertain_step, /Uploading/);
  f.state.failUpload = false;
  assert.equal((await f.run({ verify: true })).status, 200); assert.equal(f.calls.filter(call => call.action === "upload").length, 1);
  const revision = fixture(); revision.state.locked = true; revision.state.malformedRevision = true;
  const malformed = await revision.run({ verify: true, revisionReason: "Replace unusable source document." });
  assert.equal(malformed.status, 409); assert.match(malformed.data.error, /Opening the equipment revision was attempted/);
  assert.ok(!revision.calls.some(call => call.action === "upload"));
});

test("ready status belongs to this original and preserves pending/no-guidance/readback failure results", async () => {
  for (const [mode, expected] of [["other", "unavailable"], ["pending", "pending"], ["no_guidance", "no_guidance"], ["denied", "unavailable"]]) {
    const f = fixture(); f.state.guide = mode;
    const result = await f.run({ verify: true }); assert.equal(result.status, 200); assert.equal(result.data.verified, true);
    assert.equal(result.data.troubleshooting.status, expected);
    assert.doesNotMatch(result.data.message, /current native guide contains troubleshooting/);
  }
});

test("catalog mismatches and existing confirmed associations are never silently overridden", async () => {
  const f = fixture(); f.state.files = [f.file]; f.state.mismatch = true;
  const result = await f.run({ verify: true }); assert.equal(result.status, 409); assert.match(result.data.error, /not silently acknowledged/);
  assert.ok(!f.calls.some(call => ["upload", "save", "verify"].includes(call.action)));
  const existing = fixture(); existing.state.links = [{ ...existing.file, sha256: existing.evidence.sha256, applicability: "confirmed_model" }];
  assert.equal((await existing.run({ verify: false })).status, 409);
  assert.ok(!existing.calls.some(call => ["upload", "save", "verify"].includes(call.action)));
});
