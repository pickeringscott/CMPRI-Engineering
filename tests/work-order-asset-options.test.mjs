import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/work-orders/assignable-assets.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports });

const { assignableAssetsForLocation, roomAssetsForInference } = exports;

const assets = [
  { id: "room-101-active", location_id: "room-101", active: true },
  { id: "room-102-active", location_id: "room-102", active: true },
  { id: "room-101-inactive", location_id: "room-101", active: false },
  { id: "moved-current", location_id: "room-102", active: false },
  { id: "ge-template", location_id: null, active: true },
  { id: "retired-template", location_id: null, active: false },
];

test("work-order asset choices include room equipment and active unassigned catalog templates", () => {
  assert.deepEqual(
    assignableAssetsForLocation(assets, "room-101", null).map((asset) => asset.id),
    ["room-101-active", "ge-template"],
  );
});

test("the existing inactive or moved asset remains selectable for the current ticket", () => {
  assert.deepEqual(
    assignableAssetsForLocation(assets, "room-101", "moved-current").map((asset) => asset.id),
    ["room-101-active", "moved-current", "ge-template"],
  );
});

test("tickets without a location cannot select unrelated assets", () => {
  assert.deepEqual(
    assignableAssetsForLocation(assets, null, null).map((asset) => asset.id),
    ["ge-template"],
  );
});

test("catalog templates stay available globally while inference stays room-only", () => {
  for (const room of ["room-101", "room-102", "room-410", null]) {
    assert.ok(assignableAssetsForLocation(assets, room, null).some((asset) => asset.id === "ge-template"));
    assert.ok(roomAssetsForInference(assets, room).every((asset) => asset.location_id === room && asset.location_id !== null && asset.active !== false));
  }
  assert.equal(roomAssetsForInference(assets, "room-410").length, 0);
  assert.equal(roomAssetsForInference(assets, null).length, 0);
});
