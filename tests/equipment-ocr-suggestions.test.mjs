import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { suggestionsFromReviewedOcr } from "../src/lib/equipment-ocr-suggestions.ts";

test("reviewed pages provide labeled suggestions without changing their source", () => {
  const pages = [
    { page: 1, text: "Manufacturer: Example Machines\nModel: ZX120" },
    { page: 2, text: "Serial Number: ABC-12345\nInstallation Year: 2024" },
  ];
  const before = structuredClone(pages);
  const result = suggestionsFromReviewedOcr(pages);
  assert.equal(result.manufacturer, "Example Machines");
  assert.equal(result.manufacturer_source, "document");
  assert.equal(result.model_number, "ZX120");
  assert.equal(result.serial_number, "ABC-12345");
  assert.equal(result.install_year, 2024);
  assert.deepEqual(pages, before);
});

test("unlabeled or ambiguous OCR does not invent identity or select a model", () => {
  assert.equal(suggestionsFromReviewedOcr([{ page: 1, text: "Unclear handwriting and damaged label" }]), null);
  const result = suggestionsFromReviewedOcr([{ page: 1, text: "Models: AB123 CD456" }]);
  assert.deepEqual(result.model_candidates, ["AB123", "CD456"]);
  assert.equal(result.model_number, undefined);
  assert.equal(result.manufacturer, undefined);
});

test("equipment review only stages OCR suggestions for authorized, unlocked editing", () => {
  const source = readFileSync(new URL("../src/app/management/equipment/page.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("equipment.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function find(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "useReviewedOcr") handler = node.getText(file);
    ts.forEachChild(node, find);
  }
  find(file);
  assert.ok(handler, "reviewed OCR handler exists");
  const code = ts.transpileModule(`${handler}\nexports.run = useReviewedOcr;`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  let extracted, draft = {}, dialog = "";
  const context = {
    exports: {}, selectedId: "asset-1", canManage: true, verified: false, editing: true, extracted: null,
    window: { confirm: () => false },
    suggestionsFromReviewedOcr,
    setExtracted: value => { extracted = value; context.extracted = value; },
    setExtractedDraft: value => { draft = value; },
    setDialogMessage: value => { dialog = value; },
    setMessage: () => {},
  };
  vm.runInNewContext(code, context);
  const result = { fileName: "synthetic-label.png", pages: [{ page: 1, text: "Manufacturer: Example Machines\nModel: ZX120" }] };
  context.verified = true;
  context.exports.run(result);
  assert.equal(extracted, undefined, "locked verified equipment cannot receive OCR suggestions");
  context.verified = false;
  context.exports.run(result);
  assert.equal(extracted.model_number, "ZX120");
  assert.equal(draft.model_number, "ZX120");
  assert.match(dialog, /unverified/i);
  assert.match(dialog, /not been uploaded or attached/i);
  context.exports.run({ fileName: "another.png", pages: [{ page: 1, text: "Model: XY456" }] });
  assert.equal(draft.model_number, "ZX120", "existing review is kept when replacement is declined");
});
