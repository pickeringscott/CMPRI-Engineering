import test from "node:test";
import assert from "node:assert/strict";
import { practiceAskResponse, practiceWorkOrder, roomPracticePrompts } from "../src/components/beginners-guide/ask-cmpri-practice.ts";

test("the sample Room 134 conversation keeps all four linked tickets as the table changes", () => {
  const results = [];
  for (const question of roomPracticePrompts) results.push(practiceAskResponse(question, results.at(-1)?.context));
  const [room, maintenance, table, sorted] = results;
  assert.match(room.summary, /King Studio.*queen-size sofa bed/);
  assert.deepEqual(maintenance.items.map(item => item.record.id), table.table.rows.map(row => row.id));
  assert.equal(sorted.table.rows[0].cells.Priority, "High");
  assert.deepEqual(new Set(sorted.table.rows.map(row => row.id)), new Set(table.table.rows.map(row => row.id)));
  assert.equal(practiceWorkOrder(sorted.table.rows[0].cells["Work order"].record.id).number, "1086");
  assert.equal(results.some(result => result.proposal || result.savedOrder), false);
});
