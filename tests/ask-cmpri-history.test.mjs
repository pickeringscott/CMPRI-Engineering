import assert from "node:assert/strict";
import test from "node:test";
import {
  askHistoryStorageChanged,
  deleteAskHistoryEntry,
  readAskHistory,
  toggleAskHistoryKept,
  updateAskHistoryEntry,
} from "../src/components/ask-cmpri/ask-history.ts";
import {
  makeAskAttachmentRecovery,
  readAskAttachmentRecoveries,
  removeAskAttachmentRecovery,
  saveAskAttachmentRecovery,
} from "../src/components/ask-cmpri/ask-attachment-recovery.ts";

const values = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() { return values.size; },
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  },
});
const day = 86_400_000;
const entry = (id, date = Date.now()) => ({ id, date, question: id, turns: [] });

function save(scope, item) {
  return updateAskHistoryEntry(scope, item.id, () => item);
}

test("device History preserves kept entries past seven days and the recent-entry limit", () => {
  const scope = "hotel:chief:history-test";
  save(scope, entry("kept"));
  toggleAskHistoryKept(scope, "kept");
  save(scope, entry("kept", Date.now() - 20 * day));
  save(scope, entry("expired", Date.now() - 8 * day));
  for (let index = 0; index < 81; ++index) save(scope, entry("recent-" + index));
  const history = readAskHistory(scope);
  assert.equal(history.length, 81);
  assert.equal(history.find((item) => item.id === "kept")?.kept, true);
  assert.equal(history.some((item) => item.id === "expired"), false);
  assert.equal(toggleAskHistoryKept(scope, "kept").some((item) => item.id === "kept"), false);
  assert.equal(readAskHistory("hotel:other").length, 0);
});

test("a late reply cannot restore a deleted History entry even across tabs", () => {
  const scope = "hotel:chief:delete-test";
  const item = entry("call");
  localStorage.setItem("cmpri:ask-history:v1:" + scope, JSON.stringify([item]));
  assert.equal(readAskHistory(scope).length, 1);
  assert.deepEqual(deleteAskHistoryEntry(scope, item.id), []);
  assert.deepEqual(updateAskHistoryEntry(scope, item.id, () => item), []);
  const recordKey = "cmpri:ask-history:v2:" + encodeURIComponent(scope) + ":call";
  // Represents another tab writing an answer after this tab deleted the call.
  localStorage.setItem(recordKey, JSON.stringify(item));
  assert.deepEqual(readAskHistory(scope), []);
  assert.equal(askHistoryStorageChanged(scope, { key: recordKey }), true);
  assert.equal(askHistoryStorageChanged("hotel:other", { key: recordKey }), false);
});

test("pending confirmed attachment recovery is visible to its owner only", async () => {
  const batch = makeAskAttachmentRecovery({
    id: "test-photo", scope: "hotel:chief:recovery-test", token: "synthetic-token",
    files: [{ file: new File(["test fixture"], "photo.png", { type: "image/png" }), uploadId: "synthetic-upload" }],
  });
  await saveAskAttachmentRecovery(batch);
  assert.deepEqual(await readAskAttachmentRecoveries(batch.scope), [batch]);
  assert.deepEqual(await readAskAttachmentRecoveries("hotel:other"), []);
  await removeAskAttachmentRecovery(batch.scope, batch.id);
  assert.deepEqual(await readAskAttachmentRecoveries(batch.scope), []);
});
