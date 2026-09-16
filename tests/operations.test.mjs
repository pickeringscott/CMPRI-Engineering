import test from "node:test";
import assert from "node:assert/strict";
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
test("Monday GSS included", () => assert.equal(parseOperationalEmail({subject: "GSS report", messageAt:"2026-09-14T12:00:00Z"}).category, "gss"));
test("Tuesday GSS excluded", () => assert.equal(parseOperationalEmail({subject: "GSS report", messageAt:"2026-09-15T12:00:00Z"}).category, "other"));
test("credit memo retained as warranty case", () => assert.equal(parseOperationalEmail({subject: "Credit memo for returned part"}).category, "warranty"));
test("in transit purchase status", () => assert.equal(parseOperationalEmail({subject: "HD Supply shipment PO 12345",text: "In transit"}).purchaseStatus, "In Transit"));
test("not delivered does not mean delivered", () => assert.notEqual(parseOperationalEmail({subject: "HD Supply PO 12345",text: "Shipment not delivered"}).purchaseStatus, "Delivered"));
test("ship-from field stops at newline", () => assert.equal(parseOperationalEmail({subject: "HD Supply shipment PO 12345",text: "Shipped from Atlanta\nTracking: 1Z999AA10123456784"}).shipFrom, "Atlanta"));
