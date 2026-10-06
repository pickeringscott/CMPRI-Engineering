import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoomRankerContext } from "../src/lib/work-orders/room-ranker-context.ts";

test("loads the matching Room Ranker row", () => {
  assert.deepEqual(
    resolveRoomRankerContext(true, {
      rooms: [
        { room: "101", rank: "A", check1: "Complete", notes: "No issues" },
        { room: "102", rank: "B" },
      ],
    }, "101"),
    {
      ranker: { rowNumber: undefined, room: "101", rank: "A", check1: "Complete", check2: undefined, check3: undefined, notes: "No issues" },
      error: "",
    },
  );
});

test("distinguishes a room with no row from an unavailable integration", () => {
  assert.deepEqual(
    resolveRoomRankerContext(true, { rooms: [{ room: "102", rank: "B" }] }, "101"),
    { ranker: null, error: "" },
  );
});

test("surfaces API errors instead of returning an empty result", () => {
  assert.deepEqual(
    resolveRoomRankerContext(false, { error: "Room Ranker settings are missing." }, "101"),
    { ranker: null, error: "Room Ranker settings are missing." },
  );
});

test("rejects malformed successful responses", () => {
  assert.deepEqual(
    resolveRoomRankerContext(true, { rooms: "not-an-array" }, "101"),
    { ranker: null, error: "Room Ranker returned an invalid response." },
  );
});
