import assert from "node:assert/strict";
import { parseOperationalEmail } from "../src/lib/integrations/email-parser.ts";

const cases = [
  [
    "iBuy purchase",
    { subject: "iBuyEfficient Purchase Order PO 12345", text: "Your order confirmation PO # 12345 from HD Supply", from: "orders@ibuyefficient.com" },
    (result) => {
      assert.equal(result.category, "purchase");
      assert.equal(result.orderNumber, "12345");
      assert.equal(result.purchaseStatus, "Ordered");
      assert.equal(result.vendor, "HD Supply");
    },
  ],
  [
    "HD Supply split shipment",
    { subject: "HD Supply shipment for PO 12345", text: "PO # 12345 shipped from Atlanta Warehouse. Tracking 1Z999AA10123456784. Estimated Delivery: Sep 18, 2026" },
    (result) => {
      assert.equal(result.category, "shipping");
      assert.deepEqual(result.trackingNumbers, ["1Z999AA10123456784"]);
      assert.equal(result.shipFrom, "Atlanta Warehouse");
      assert.equal(result.purchaseStatus, "Shipped");
    },
  ],
  [
    "Enseo endpoint",
    { subject: "Enseo Ticket 55501 update", text: "Issue reported for room 103A STB. Ticket # 55501" },
    (result) => {
      assert.equal(result.category, "enseo");
      assert.equal(result.roomNumber, "103");
      assert.equal(result.enseoEndpoint, "103A");
    },
  ],
  [
    "GSS score report",
    { subject: "Weekly GSS Scores", text: "Overall Satisfaction: 87.5%\nRoom Cleanliness: 91%\nStaff Service: 94%" },
    (result) => {
      assert.equal(result.category, "gss");
      assert.equal(result.gssScores["Overall Satisfaction"], 87.5);
      assert.equal(result.gssScores["Room Cleanliness"], 91);
    },
  ],
  [
    "Warranty / RMA replacement",
    { subject: "Warranty replacement RMA 77881 shipped", text: "RMA # 77881 replacement part shipped from Chicago. Tracking: 1Z999AA10123456784" },
    (result) => {
      assert.equal(result.category, "warranty");
      assert.equal(result.rmaNumber, "77881");
      assert.equal(result.trackingNumbers.length, 1);
    },
  ],
  [
    "Missing-item supplier follow-up",
    { subject: "PO 12345 missing item", text: "We did not receive one item from the shipment. PO # 12345", direction: "outbound" },
    (result) => {
      assert.equal(result.category, "supplier_followup");
      assert.match(result.followupStatus || "", /Awaiting Response/);
    },
  ],
];

let passed = 0;
for (const [name, input, verify] of cases) {
  const result = parseOperationalEmail(input);
  verify(result);
  passed += 1;
  console.log(`PASS ${name}`);
}
console.log(`email-parser tests: ${passed}/${cases.length} passed`);
