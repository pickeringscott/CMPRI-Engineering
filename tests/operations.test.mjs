import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { mergedPurchaseStatus, parentStatusFromShipments, matchEnseoWorkOrder } from "../src/lib/integrations/operations.ts";
import { parseOperationalEmail } from "../src/lib/integrations/email-parser.ts";

for (const [old, next, expected] of [
  ["", "", "Ordered"], ["Ordered", "Shipped", "Shipped"], ["Delivered", "Shipped", "Delivered"],
  ["Received", "Delivered", "Received"], ["Installed / Used", "Shipped", "Installed / Used"],
  ["Complete", "Cancelled", "Complete"], ["Cancelled", "Received", "Cancelled"],
  ["Shipped", "In Transit", "In Transit"], ["In Transit", "Shipped", "In Transit"],
]) test(`merge ${old} + ${next}`, () => assert.equal(mergedPurchaseStatus(old, next), expected));

for (const [shipments, current, expected] of [
  [[], "Ordered", "Ordered"], [["Shipped", "Delivered"], "Delivered", "Partially Shipped"],
  [["Received", "Shipped"], "Shipped", "Partially Received"],
  [["Received", "Received"], "Partially Received", "Partially Received"],
  [["Received"], "Backordered", "Partially Received"], [["Received"], "Received", "Received"],
  [["Shipped"], "Complete", "Complete"], [["Delivered"], "Installed / Used", "Installed / Used"],
  [["Received"], "Cancelled", "Cancelled"], [["In Transit", "Shipped"], "Shipped", "In Transit"],
  [["Delivered", "Delivered"], "Shipped", "Delivered"],
]) test(`aggregate ${shipments}/${current}`, () => assert.equal(parentStatusFromShipments(shipments, current), expected));

const tv = { id: "tv", room: "103", issue: "TV picture missing", status: "Open" };
test("one active TV work order matches", () => assert.equal(matchEnseoWorkOrder([tv], "103", "103A"), "tv"));
test("non-TV issue is not linked by room", () => assert.equal(matchEnseoWorkOrder([{...tv, issue: "Leaking faucet"}], "103"), null));
test("ambiguous TV matches remain unlinked", () => assert.equal(matchEnseoWorkOrder([tv, {...tv, id: "second"}], "103"), null));
test("closed TV work order remains unlinked", () => assert.equal(matchEnseoWorkOrder([{...tv, status: "Closed"}], "103"), null));
test("wrong STB suffix remains unlinked", () => assert.equal(matchEnseoWorkOrder([{...tv, issue: "TV 103B"}], "103", "103A"), null));
test("matching suffixed room preserved", () => assert.equal(matchEnseoWorkOrder([{...tv, room: "103A"}], "103", "103A"), "tv"));
test("unrelated room remains unlinked", () => assert.equal(matchEnseoWorkOrder([tv], "104"), null));
// Execute the actual page with deterministic hook state; never run effects or contact providers.
function purchasingTree(canEdit, embedded, safeMode = false) {
  const source = readFileSync(new URL("../src/app/engineering/purchasing/page.tsx", import.meta.url), "utf8");
  const data = { can_edit: canEdit, safe_mode: safeMode, configured: true,
    purchases: ["Ordered", "Received", "Installed / Used"].map((status, index) => ({
      id: `purchase-${index}`, status,
      cmpri_purchase_shipments: index === 0 ? [{ id: "shipment", status: "Shipped" }] : [],
    })), enseo: [], warranties: [], followups: [] };
  const states = [data, "", false, true, false, null];
  let stateIndex = 0;
  const element = (type, props) => ({ type, props });
  const dependencies = {
    react: { useState: () => [states[stateIndex++], () => {}], useCallback: (fn) => fn, useEffect: () => {} },
    "react/jsx-runtime": { jsx: element, jsxs: element },
    "@/lib/supabase/client": { getValidSession: async () => { throw new Error("Unexpected session access"); } },
    "@/components/use-embedded-modal": { default: () => embedded },
    "@/components/MailboxChecksumComparison": { default: "mailbox-checksum" },
    "@/components/ModalDashboardLink": { default: "dashboard-link" },
    "@/components/ModalNavigationButton": { default: "navigation-link" },
    "@/lib/auth/session-preference": {},
    "@/lib/auth/client-session": {},
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  }}).outputText, { exports, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected page dependency: ${name}`);
    return dependencies[name];
  }, fetch() { throw new Error("Unexpected network access"); } });
  const tree = exports.default();
  assert.equal(stateIndex, states.length, "Update the fixture when page hook state changes");
  const nodes = [];
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    nodes.push(node);
    visit(node.props?.children);
  }
  visit(tree);
  return nodes;
}

test("purchasing mutation controls are rendered only for integration operators", () => {
  for (const embedded of [false, true]) {
    for (const permission of [false, undefined, null, "true"]) {
      const nodes = purchasingTree(permission, embedded);
      assert.equal(nodes.filter(node => node.type === "button").length, 0, `Denied permission ${permission}`);
      assert.equal(nodes.some(node => node.type === "mailbox-checksum"), false);
      assert.ok(nodes.some(node => node.props?.children === "Orders & Shipments"), "Read-only activity remains visible");
    }
    const nodes = purchasingTree(true, embedded);
    const buttons = nodes.filter(node => node.type === "button");
    assert.deepEqual(buttons.map(node => node.props.children).sort(),
      ["Scan Email Now", "Mark Received", "Mark Received", "Mark Installed / Used", "Complete", "Mark Delivered"].sort());
    assert.ok(buttons.every(node => typeof node.props.onClick === "function" && !node.props.disabled));
    assert.equal(nodes.filter(node => node.type === "mailbox-checksum").length, 1);
    const safeScan = purchasingTree(true, embedded, true).find(node => node.type === "button" && node.props.children === "Email Scanning Disabled (Safe Mode)");
    assert.equal(safeScan?.props.disabled, true);
  }
});
test("restricted engineering pages and data APIs require explicit engineering-operations capability", () => {
  const pagePaths = [
    "../src/app/engineering/gss/page.tsx",
    "../src/app/engineering/purchasing/page.tsx",
    "../src/app/engineering/enseo-assignments/page.tsx",
    "../src/app/engineering/room-operations/page.tsx",
    "../src/app/management/rooms/page.tsx",
  ];
  for (const path of pagePaths) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /view_engineering_operations/, `${path} must gate its UI`);
  }
  const apiPolicies = [
    ["../src/app/api/engineering/operations/route.ts", /allows\(auth\.principal, "view_engineering_operations"\)/],
    ["../src/app/api/enseo/assignments/route.ts", /allows\(auth\.principal, "view_engineering_operations"\)/],
    ["../src/app/api/rooms/route.ts", /allows\(principal, "view_engineering_operations"\)/],
    ["../src/app/api/room-operations/route.ts", /requireCapability\(request, "view_engineering_operations"\)/],
  ];
  for (const [path, policy] of apiPolicies) {
    assert.match(readFileSync(new URL(path, import.meta.url), "utf8"), policy, `${path} must enforce the policy server-side`);
  }
});
test("Monday GSS included", () => assert.equal(parseOperationalEmail({subject: "GSS report", messageAt:"2026-09-14T12:00:00Z"}).category, "gss"));
test("Tuesday GSS excluded", () => assert.equal(parseOperationalEmail({subject: "GSS report", messageAt:"2026-09-15T12:00:00Z"}).category, "other"));
test("credit memo retained as warranty case", () => assert.equal(parseOperationalEmail({subject: "Credit memo for returned part"}).category, "warranty"));
test("in transit purchase status", () => assert.equal(parseOperationalEmail({subject: "HD Supply shipment PO 12345",text: "In transit"}).purchaseStatus, "In Transit"));
test("not delivered does not mean delivered", () => assert.notEqual(parseOperationalEmail({subject: "HD Supply PO 12345",text: "Shipment not delivered"}).purchaseStatus, "Delivered"));
test("ship-from field stops at newline", () => assert.equal(parseOperationalEmail({subject: "HD Supply shipment PO 12345",text: "Shipped from Atlanta\nTracking: 1Z999AA10123456784"}).shipFrom, "Atlanta"));
