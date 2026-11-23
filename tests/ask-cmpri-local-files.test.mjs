import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

function browser({ pick } = {}) {
  const downloads = [];
  const api = loadTs("src/components/ask-cmpri/local-file-storage.ts", {}, {
    window: { isSecureContext: true, showDirectoryPicker: pick },
    navigator: {},
    DOMException,
    File,
    URL,
    setTimeout(callback) { callback(); },
    document: {
      createElement() { return { click() { downloads.push(this.download); }, remove() {} }; },
      body: { append() {} },
    },
  });
  return { api, downloads };
}

function testFolder(failure) {
  const entries = new Map();
  const folder = {
    name: "CMPRI-Engineering",
    async getFileHandle(name, options) {
      if (!entries.has(name)) {
        if (!options?.create) throw new DOMException("File absent", "NotFoundError");
        entries.set(name, new Blob());
      }
      let pending;
      return {
        name,
        async isSameEntry(other) { return other.name === name; },
        async createWritable() {
          if (failure === "open" || failure === "cleanup") throw new DOMException("File cannot be opened", "NotAllowedError");
          return {
            async write(blob) {
              pending = blob;
              if (failure === "outside-write") entries.set(name, new Blob(["External file"]));
            },
            async close() { entries.set(name, pending); },
            async abort() {},
          };
        },
        async getFile() {
          const saved = entries.get(name);
          if (failure === "readback" && saved.size) throw new DOMException("Committed file cannot be read", "NotAllowedError");
          return new File([saved], name, { type: saved.type });
        },
      };
    },
    async removeEntry(name) {
      if (failure === "cleanup") throw new DOMException("Removal unavailable", "NotAllowedError");
      entries.delete(name);
    },
  };
  return { folder, entries };
}

test("an interrupted folder write removes its empty target before browser fallback", async () => {
  const { api, downloads } = browser();
  const { folder, entries } = testFolder("open");
  api.setActiveAskCmpriFolder("account-a", folder);
  assert.equal(await api.downloadAskCmpriFile("account-a", "Fixture.txt", new Blob(["Fixture"])), "browser");
  assert.equal(entries.size, 0);
  assert.deepEqual(downloads, ["Fixture.txt"]);
});

test("a committed folder write survives readback failure without a second download", async () => {
  const { api, downloads } = browser();
  const { folder, entries } = testFolder("readback");
  api.setActiveAskCmpriFolder("account-a", folder);
  assert.equal(await api.downloadAskCmpriFile("account-a", "Fixture.txt", new Blob(["Fixture"])), "folder");
  assert.equal(await entries.get("Fixture.txt").text(), "Fixture");
  assert.deepEqual(downloads, []);
});

test("an unconfirmed folder cleanup leaves the browser fallback for an explicit later decision", async () => {
  const { api, downloads } = browser();
  const { folder, entries } = testFolder("cleanup");
  api.setActiveAskCmpriFolder("account-a", folder);
  await assert.rejects(api.downloadAskCmpriFile("account-a", "Fixture.txt", new Blob(["Fixture"])), {
    fileName: "Fixture.txt",
    message: "Check the selected folder before downloading another copy.",
  });
  assert.equal(entries.get("Fixture.txt").size, 0);
  assert.deepEqual(downloads, []);
});

test("a file written into the target by another program is preserved", async () => {
  const { api, downloads } = browser();
  const { folder, entries } = testFolder("outside-write");
  api.setActiveAskCmpriFolder("account-a", folder);
  await assert.rejects(api.downloadAskCmpriFile("account-a", "Fixture.txt", new Blob(["Ask CMPRI copy"])), { fileName: "Fixture.txt" });
  assert.equal(await entries.get("Fixture.txt").text(), "External file");
  assert.deepEqual(downloads, []);
});

test("a save never replaces existing media and folder handles stay account-scoped", async () => {
  const { api, downloads } = browser();
  const { folder, entries } = testFolder();
  api.setActiveAskCmpriFolder("account-a", folder);
  entries.set("Fixture.txt", new Blob(["Original"]));
  await api.downloadAskCmpriFile("account-a", "Fixture.txt", new Blob(["Added"]));
  assert.equal(await entries.get("Fixture.txt").text(), "Original");
  assert.equal(await entries.get("Fixture (2).txt").text(), "Added");
  assert.equal(await api.downloadAskCmpriFile("account-b", "Fixture.txt", new Blob(["Other user"])), "browser");
  assert.equal(entries.size, 2);
  assert.deepEqual(downloads, ["Fixture.txt"]);
});

test("the picker requests Documents and only creates the requested child for a granted Documents handle", async () => {
  const { folder } = testFolder();
  const { api } = browser({ pick: async (options) => {
    assert.equal(options.startIn, "documents");
    assert.equal(options.mode, "readwrite");
    return {
      name: "Documents",
      async getDirectoryHandle(name, childOptions) {
        assert.equal(name, "CMPRI-Engineering");
        assert.equal(childOptions.create, true);
        return folder;
      },
    };
  } });
  assert.equal(await api.pickAskCmpriFolder(), folder);
});
