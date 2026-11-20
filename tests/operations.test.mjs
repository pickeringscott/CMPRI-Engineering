import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { loadTs } from "./helpers/load-ts.mjs";
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
// Execute the actual PO entry component with explicit capability-derived state.
function purchasingTree(access) {
 const source=readFileSync(new URL("../src/app/engineering/purchasing/page.tsx",import.meta.url),"utf8");
 const exports={};const deps={react:{useState:()=>[access,()=>{}],useEffect:()=>{}},"react/jsx-runtime":{jsx:(type,props)=>({type,props})},"@/lib/auth/client-session":{},"@/lib/auth/session-preference":{},"@/lib/dashboard/chief-module-access":{},"./PurchaseOrders":{default:"purchase-orders"}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:n=>{assert.ok(Object.hasOwn(deps,n));return deps[n];}});
 return exports.default();
}
test("PO page supports view-only access and separately gates source imports",()=>{
 assert.equal(purchasingTree(null),null);
 const viewer = purchasingTree({ canManage: false, canImport: false }).props;
 assert.equal(viewer.canManage,false);
 assert.equal(viewer.canImport,false);
 assert.equal(purchasingTree({ canManage: true, canImport: true }).props.canImport,true);
 const page=readFileSync(new URL("../src/app/engineering/purchasing/page.tsx",import.meta.url),"utf8");
 assert.match(page,/hasCapability\(session, "manage_assets"\)/);
 assert.match(page,/canReadChiefModules\(session\.user\)/);
 assert.match(page,/canImport: canManage && hasCapability\(session, "operate_integrations"\)/);
});
test("engineering modules share their role checks between pages and authenticated read endpoints", () => {
  const menuPolicies = [
    ["gss", "engineering/gss/source", "canOpenGss", "session"],
    ["enseo-assignments", "enseo/assignments", "canOpenEnseo", "session"],
    ["room-operations", "room-operations", "canOpenRoomOperations", "current"],
  ];
  for (const [page, api, policy, session] of menuPolicies) {
    const pageSource = readFileSync(new URL(`../src/app/engineering/${page}/page.tsx`, import.meta.url), "utf8");
    const apiSource = readFileSync(new URL(`../src/app/api/${api}/route.ts`, import.meta.url), "utf8");
    assert.ok(pageSource.includes(`${policy}(${session}.user)`), `${page} must gate its UI`);
    assert.match(apiSource, /await requireUserAttempt\(request\)/, `${api} must authenticate reads`);
    assert.match(apiSource, new RegExp(`${policy}\\((?:auth\\.)?principal\\.profile\\)`), `${api} must enforce the same policy`);
  }
  const apiPolicies = [
    ["../src/app/api/engineering/operations/route.ts", /allows\(auth\.principal, "view_engineering_operations"\)/],
    ["../src/app/api/enseo/assignments/route.ts", /requireCapability\(request, "manage_assets"\)/],
    ["../src/app/api/room-operations/route.ts", /requireCapability\(request, "edit_tickets"\)/],
  ];
  for (const [path, policy] of apiPolicies) {
    assert.match(readFileSync(new URL(path, import.meta.url), "utf8"), policy, `${path} must enforce the policy server-side`);
  }
});
test("menu module access matches the approved role matrix", () => {
  const { isChiefMenuRole, canOpenEnseo, canOpenGss, canOpenRoomOperations, canOpenWeather } =
    loadTs("src/lib/dashboard/menu-access.ts");
  for (const [role, chief, gss, roomOps, enseo, weather] of [
    ["chief_engineer", true, true, true, true, true],
    ["engineer", true, true, true, true, true],
    ["senior_management", true, true, true, true, true],
    ["system_admin", true, true, true, true, true],
    ["manager", false, true, true, false, true],
    ["assistant_manager", false, true, false, false, false],
    ["front_desk_manager", false, true, false, false, false],
    ["technician", false, true, true, true, true],
    ["front_desk", false, false, false, false, true],
    ["housekeeping", false, false, false, false, true],
    ["unknown", false, false, false, false, false],
  ]) {
    const profile = { role };
    assert.deepEqual([
      isChiefMenuRole(profile), canOpenGss(profile), canOpenRoomOperations(profile),
      canOpenEnseo(profile), canOpenWeather(profile),
    ], [chief, gss, roomOps, enseo, weather], role);
  }
});
test("Monday GSS included", () => assert.equal(parseOperationalEmail({subject: "GSS report", messageAt:"2026-09-14T12:00:00Z"}).category, "gss"));
test("Tuesday GSS excluded", () => assert.equal(parseOperationalEmail({subject: "GSS report", messageAt:"2026-09-15T12:00:00Z"}).category, "other"));
test("scoreless GSS messages cannot replace a weekly report", async () => {
  const source = readFileSync(new URL("../src/app/api/integrations/email/scan/route.ts", import.meta.url), "utf8");
  const exports = {};
  const dependencies = {
    "next/server": {},
    "@/lib/integrations/email-parser": { parseOperationalEmail },
    "@/lib/constants": { HOTEL_ID: "hotel" },
    "@/lib/server/auth": {},
    "@/lib/server/supabase-admin": {},
    "@/lib/integrations/email-provider": {},
    "@/lib/integrations/operations": { mergedPurchaseStatus, parentStatusFromShipments, matchEnseoWorkOrder },
    "@/lib/server/integrations-safe-mode": {},
  };
  vm.runInNewContext(ts.transpileModule(`${source}\nexport { saveOperationalRecord };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } });

  let report;
  let completed = 0;
  const admin = { from(table) {
    if (table === "cmpri_email_events") return {
      select: () => ({ eq() { return this; }, maybeSingle: async () => ({ data: null }) }),
      upsert: () => ({ select: () => ({ single: async () => ({ data: { id: "event" } }) }) }),
      update: () => ({ eq: async () => { completed++; return {}; } }),
    };
    if (table === "cmpri_gss_reports") return { upsert: async row => { report = row; return {}; } };
    assert.fail(`Unexpected table ${table}`);
  } };
  const message = { id: "1", subject: "Weekly GSS report", text: "Overall Satisfaction: 87.5%", from: "sender", to: "recipient", direction: "inbound", messageAt: "2026-09-14T12:00:00Z" };
  await exports.saveOperationalRecord(admin, message);
  assert.equal(report.scores["Overall Satisfaction"], 87.5);
  await exports.saveOperationalRecord(admin, { ...message, id: "2", subject: "Re: Weekly GSS report", text: "Thanks for the report." });
  assert.equal(report.scores["Overall Satisfaction"], 87.5);
  await exports.saveOperationalRecord(admin, { ...message, id: "3", text: "Overall Satisfaction: 0%" });
  assert.equal(report.scores["Overall Satisfaction"], 0);
  assert.equal(completed, 3);
});
test("credit memo retained as warranty case", () => assert.equal(parseOperationalEmail({subject: "Credit memo for returned part"}).category, "warranty"));
test("in transit purchase status", () => assert.equal(parseOperationalEmail({subject: "HD Supply shipment PO 12345",text: "In transit"}).purchaseStatus, "In Transit"));
test("not delivered does not mean delivered", () => assert.notEqual(parseOperationalEmail({subject: "HD Supply PO 12345",text: "Shipment not delivered"}).purchaseStatus, "Delivered"));
test("ship-from field stops at newline", () => assert.equal(parseOperationalEmail({subject: "HD Supply shipment PO 12345",text: "Shipped from Atlanta\nTracking: 1Z999AA10123456784"}).shipFrom, "Atlanta"));
