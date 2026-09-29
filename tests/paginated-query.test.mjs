import assert from "node:assert/strict";
import test from "node:test";
import { fetchAllPages } from "../src/lib/server/paginated-query.ts";

test("fetchAllPages returns every row across full and partial pages", async () => {
  const rows = Array.from({ length: 2101 }, (_, index) => ({ id: index }));
  const ranges = [];
  const result = await fetchAllPages(async (from, to) => {
    ranges.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  });

  assert.equal(result.error, null);
  assert.equal(result.data?.length, rows.length);
  assert.deepEqual(result.data, rows);
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test("fetchAllPages surfaces page errors without returning a partial success result", async () => {
  const failure = new Error("Page failed");
  let requests = 0;
  const result = await fetchAllPages(async () => {
    requests += 1;
    if (requests === 1) return { data: [{ id: "first" }], error: null };
    return { data: null, error: failure };
  }, 1);

  assert.equal(result.data, null);
  assert.equal(result.error, failure);
  assert.equal(requests, 2);
});
