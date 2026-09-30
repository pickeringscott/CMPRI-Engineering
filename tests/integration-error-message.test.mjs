import test from "node:test";
import assert from "node:assert/strict";
import { integrationErrorMessage } from "../src/lib/server/integrations-safe-mode.ts";

test("integrationErrorMessage normalizes OpenSSL decoder errors", () => {
  const message = integrationErrorMessage(
    new Error("error:1E08010C:DECODER routines::unsupported"),
    "Room Ranker",
  );
  assert.match(message, /Room Ranker credentials are misconfigured/);
});

test("integrationErrorMessage preserves unrelated errors", () => {
  const message = integrationErrorMessage(new Error("Spreadsheet not found"), "Room Ranker");
  assert.equal(message, "Spreadsheet not found");
});
