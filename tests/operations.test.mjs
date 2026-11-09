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
// Execute the actual PO entry component with explicit capability-derived state.
function purchasingTree(allowed, canImport) {
 const source=readFileSync(new URL("../src/app/engineering/purchasing/page.tsx",import.meta.url),"utf8"),states=[allowed,canImport];let i=0;
 const exports={};const deps={react:{useState:()=>[states[i++],()=>{}],useEffect:()=>{}},"react/jsx-runtime":{jsx:(type,props)=>({type,props})},"@/lib/auth/client-session":{},"@/lib/auth/session-preference":{},"./PurchaseOrders":{default:"purchase-orders"}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:n=>{assert.ok(Object.hasOwn(deps,n));return deps[n];}});
 return exports.default();
}
test("PO page requires parts management and separately gates source imports",()=>{
 assert.equal(purchasingTree(false,false),null);
 for(const permission of [false,undefined,null,"true"])assert.equal(purchasingTree(true,permission).props.canImport,false);
 assert.equal(purchasingTree(true,true).props.canImport,true);
 const page=readFileSync(new URL("../src/app/engineering/purchasing/page.tsx",import.meta.url),"utf8");
 assert.match(page,/hasCapability\(session,'manage_assets'\)/);assert.match(page,/hasCapability\(session,"operate_integrations"\)/);
});
test("restricted engineering pages and data APIs require explicit engineering-operations capability", () => {
  const pagePaths = [
    "../src/app/engineering/gss/page.tsx",
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
