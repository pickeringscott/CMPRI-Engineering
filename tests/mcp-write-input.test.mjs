import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeMcpFeedbackInput,
  normalizeMcpWorkOrderUpdate,
} from "../src/lib/ai/mcp-write-input.ts";

test("work-order MCP updates flatten nested editable changes and retain revision guard", () => {
  const payload = normalizeMcpWorkOrderUpdate({
    id: "work-order-id",
    expected_revision: 7,
    changes: {
      notes: "Replaced the thermostat.",
      status: "in progress",
      assigned_technician: "Morgan Lee",
    },
  });

  assert.deepEqual(payload, {
    id: "work-order-id",
    expected_revision: 7,
    notes: "Replaced the thermostat.",
    status: "In Progress",
    technician_name: "Morgan Lee",
  });
});

test("work-order MCP updates accept fields and updates wrappers", () => {
  assert.deepEqual(normalizeMcpWorkOrderUpdate({
    id: "work-order-id",
    expected_revision: 2,
    fields: { notes: "New note" },
  }), {
    id: "work-order-id",
    expected_revision: 2,
    notes: "New note",
  });
  assert.deepEqual(normalizeMcpWorkOrderUpdate({
    id: "work-order-id",
    expected_revision: 3,
    updates: { technician: "Morgan Lee" },
  }), {
    id: "work-order-id",
    expected_revision: 3,
    technician_name: "Morgan Lee",
  });
});

test("work-order MCP writes reject malformed or empty changes clearly", () => {
  assert.throws(() => normalizeMcpWorkOrderUpdate({
    id: "work-order-id",
    expected_revision: 1,
    changes: [],
  }), /changes must be supplied as an object/);
  assert.throws(() => normalizeMcpWorkOrderUpdate({
    id: "work-order-id",
    expected_revision: 1,
  }), /No editable work-order changes were supplied/);
});

test("feedback MCP input normalizes Bug casing and common type alias", () => {
  assert.deepEqual(normalizeMcpFeedbackInput({
    type: " bug ",
    description: "A defect.",
    originating_page: "/work-orders",
  }), {
    type: " bug ",
    feedback_type: "Bug",
    description: "A defect.",
    originating_page: "/work-orders",
    page_route: "/work-orders",
  });
});

test("feedback MCP input falls back to the MCP route for missing or non-path origins", () => {
  assert.equal(normalizeMcpFeedbackInput({
    feedback_type: "Problem",
    description: "Could not save.",
    originating_page: "ChatGPT",
  }).page_route, "/mcp");
  assert.equal(normalizeMcpFeedbackInput({
    feedback_type: "Bug",
    description: "Could not save.",
    page_route: "//external.example",
    route: "/engineering/pool-log",
  }).page_route, "/engineering/pool-log");
});
