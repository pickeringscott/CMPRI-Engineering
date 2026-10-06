import assert from "node:assert/strict";
import test from "node:test";
import { enseoSaveSuccessMessage, resolveEnseoPageResponse } from "../src/lib/enseo-page-state.ts";

const validPayload = {
  configured: true,
  can_manage: false,
  assignments: [],
  assets: [],
  locations: [],
  history: [],
};

test("unauthorized Enseo responses remain errors instead of becoming incomplete page data", () => {
  const result = resolveEnseoPageResponse(false, { error: "Engineering access is required." });

  assert.equal(result.data, null);
  assert.equal(result.message, "Engineering access is required.");
});

test("read-only Enseo responses retain data but do not grant management controls", () => {
  const result = resolveEnseoPageResponse(true, validPayload);

  assert.deepEqual(result.data, validPayload);
  assert.equal(result.message, null);
});

test("unconfigured Enseo storage renders its explicit configuration state", () => {
  const payload = {
    configured: false,
    assignments: [],
    assets: [],
    locations: [],
    history: [],
  };
  const result = resolveEnseoPageResponse(false, payload);

  assert.deepEqual(result.data, payload);
  assert.equal(result.message, null);
});

test("malformed successful Enseo responses are surfaced rather than defaulted", () => {
  const result = resolveEnseoPageResponse(true, { configured: true, can_manage: true });

  assert.equal(result.data, null);
  assert.equal(result.message, "Enseo assignments returned an invalid response.");
});

test("Enseo save confirmation describes singular and batched assignments", () => {
  assert.equal(enseoSaveSuccessMessage(1), "Saved 1 device assignment as one atomic move batch.");
  assert.equal(enseoSaveSuccessMessage(2), "Saved 2 device assignments as one atomic move batch.");
});
