/** Device-only, owner-scoped bytes for attachments that have not been confirmed uploaded. */
export type AttachmentDraftScope = { hotelId: string; userId: string; editorId: string };
export type AttachmentDraftFile = { file: File; uploadId: string };
export type AttachmentDraft = {
  draftIdentity: string;
  files: AttachmentDraftFile[];
  uploads?: { workOrderId: string; displayId: string; uploadId: string }[];
};

export const ATTACHMENT_DRAFT_LIMITS = {
  files: 25,
  fileBytes: 100 * 1024 * 1024,
  editorBytes: 200 * 1024 * 1024,
  deviceBytes: 512 * 1024 * 1024,
  editors: 50,
} as const;

const DATABASE = "cmpri-work-order-attachments-v1";
const DRAFTS = "drafts", METADATA = "metadata";
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const mediaTypes: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", heic: "image/heic", heif: "image/heif", mp4: "video/mp4",
  mov: "video/quicktime", webm: "video/webm",
};
type StoredFile = { blob: Blob; name: string; type: string; lastModified: number; uploadId: string };
type StoredDraft = AttachmentDraftScope & { version: 1; key: string; bytes: number; draftIdentity: string; files: StoredFile[]; uploads?: AttachmentDraft["uploads"] };
type Usage = { count: number; bytes: number };
const queues = new WeakMap<IDBFactory, Map<string, Promise<unknown>>>();

function failure(reason: "invalid" | "storage" | "quota" | "corrupt") {
  const message = reason === "invalid"
    ? "Selected attachments could not be retained. Use up to 25 supported photos or videos, 100 MB each and 200 MB total, and keep this window open until they are uploaded."
    : reason === "quota"
      ? "This browser has insufficient storage to keep selected attachments. Keep this window open, free device storage, and retry before closing."
      : reason === "corrupt"
        ? "Retained attachments could not be restored. Keep this window open and reselect the affected files before submitting."
        : "This browser could not keep selected attachments on this device. Keep this window open and upload them, or enable browser storage and retry before closing.";
  return new Error(message);
}
function storageFailure(error: unknown) {
  return failure(error && typeof error === "object" && "name" in error && error.name === "QuotaExceededError" ? "quota" : "storage");
}
function keyFor(scope: AttachmentDraftScope) {
  if (!scope || typeof scope.hotelId !== "string" || !uuid.test(scope.hotelId) || typeof scope.userId !== "string" || !uuid.test(scope.userId)
    || typeof scope.editorId !== "string" || scope.editorId !== "create" && !uuid.test(scope.editorId)) throw failure("invalid");
  return JSON.stringify([scope.hotelId.toLowerCase(), scope.userId.toLowerCase(), scope.editorId.toLowerCase()]);
}
function factoryFor(factory?: IDBFactory) {
  try {
    const found = factory || globalThis.indexedDB;
    if (!found) throw failure("storage");
    return found;
  } catch { throw failure("storage"); }
}
function validIdentity(value: unknown, scope: AttachmentDraftScope): value is string {
  if (value === "") return true;
  if (typeof value !== "string" || value.length > 160) return false;
  const match = value.match(/^(draft|pending|ticket):([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?::(0|[1-9]\d{0,14}))?$/i);
  if (!match || (match[1] === "pending" ? match[3] !== undefined : !Number.isSafeInteger(Number(match[3])))) return false;
  return scope.editorId === "create" ? match[1] !== "ticket" : match[1] !== "pending" && match[2].toLowerCase() === scope.editorId.toLowerCase();
}
function normalizeFile(file: File, uploadId: unknown): StoredFile {
  if (!(file instanceof Blob) || typeof file.name !== "string" || !file.name || file.name.length > 255
    || /[\x00-\x1f\x7f/\\<>]/.test(file.name) || !Number.isSafeInteger(file.lastModified) || file.lastModified < 0
    || typeof uploadId !== "string" || !uuid.test(uploadId) || file.size < 1 || file.size > ATTACHMENT_DRAFT_LIMITS.fileBytes) throw failure("invalid");
  const expectedType = mediaTypes[file.name.split(".").pop()?.toLowerCase() || ""];
  if (!expectedType || file.type && file.type !== "application/octet-stream" && file.type.toLowerCase() !== expectedType) throw failure("invalid");
  return { blob: file.slice(0, file.size, file.type), name: file.name, type: file.type, lastModified: file.lastModified, uploadId: uploadId.toLowerCase() };
}
function normalize(scope: AttachmentDraftScope, draft: AttachmentDraft): StoredDraft {
  const key = keyFor(scope);
  if (!draft || !validIdentity(draft.draftIdentity, scope) || !Array.isArray(draft.files) || draft.files.length > ATTACHMENT_DRAFT_LIMITS.files) throw failure("invalid");
  const files = draft.files.map(entry => normalizeFile(entry?.file, entry?.uploadId));
  const ids = new Set(files.map(file => file.uploadId));
  const bytes = files.reduce((total, file) => total + file.blob.size, 0);
  if (ids.size !== files.length || bytes > ATTACHMENT_DRAFT_LIMITS.editorBytes) throw failure("invalid");
  let uploads: AttachmentDraft["uploads"];
  if (draft.uploads !== undefined) {
    if (!Array.isArray(draft.uploads) || draft.uploads.length > 250) throw failure("invalid");
    const seen = new Set<string>();
    uploads = draft.uploads.map(entry => {
      if (!entry || !uuid.test(entry.workOrderId) || !uuid.test(entry.uploadId) || !ids.has(entry.uploadId.toLowerCase())
        || typeof entry.displayId !== "string" || !/^[a-z\d_-]{1,100}$/i.test(entry.displayId)
        || scope.editorId !== "create" && entry.workOrderId.toLowerCase() !== scope.editorId.toLowerCase()) throw failure("invalid");
      const identity = `${entry.workOrderId.toLowerCase()}:${entry.uploadId.toLowerCase()}`;
      if (seen.has(identity)) throw failure("invalid");
      seen.add(identity);
      return { workOrderId: entry.workOrderId.toLowerCase(), displayId: entry.displayId, uploadId: entry.uploadId.toLowerCase() };
    });
  }
  return { version: 1, key, hotelId: scope.hotelId.toLowerCase(), userId: scope.userId.toLowerCase(), editorId: scope.editorId.toLowerCase(),
    bytes, draftIdentity: draft.draftIdentity, files, ...(uploads ? { uploads } : {}) };
}
function request<T>(value: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}
function complete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}
function open(factory: IDBFactory) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(failure("storage")); }, 10_000);
    let opening: IDBOpenDBRequest;
    try { opening = factory.open(DATABASE, 1); }
    catch (error) { clearTimeout(timer); reject(storageFailure(error)); return; }
    opening.onupgradeneeded = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: "key" });
      if (!db.objectStoreNames.contains(METADATA)) db.createObjectStore(METADATA);
    };
    opening.onerror = () => { clearTimeout(timer); expired = true; reject(storageFailure(opening.error)); };
    opening.onblocked = () => { clearTimeout(timer); expired = true; reject(failure("storage")); };
    opening.onsuccess = () => {
      clearTimeout(timer);
      const db = opening.result;
      if (expired) { db.close(); return; }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
async function serialized<T>(factory: IDBFactory, key: string, operation: () => Promise<T>) {
  let pending = queues.get(factory);
  if (!pending) { pending = new Map(); queues.set(factory, pending); }
  const next = (pending.get(key) || Promise.resolve()).catch(() => {}).then(operation);
  pending.set(key, next);
  try { return await next; }
  finally { if (pending.get(key) === next) pending.delete(key); }
}

/** Resolves only after the bytes and their upload identities commit together. Never evicts another draft. */
export async function saveAttachmentDraft(scope: AttachmentDraftScope, draft: AttachmentDraft, factory?: IDBFactory): Promise<void> {
  const row = normalize(scope, draft), host = factoryFor(factory);
  return serialized(host, row.key, async () => {
    const db = await open(host);
    try {
      const tx = db.transaction([DRAFTS, METADATA], "readwrite"), done = complete(tx);
      // Attach a rejection handler before awaiting requests so an aborted transaction never leaks an unhandled rejection.
      void done.catch(() => {});
      const meta = tx.objectStore(METADATA);
      const [old, stored] = await Promise.all([request<number | undefined>(meta.get(row.key)), request<Usage | undefined>(meta.get("usage"))]);
      const usage = stored || { count: 0, bytes: 0 };
      usage.count += old === undefined ? 1 : 0;
      usage.bytes += row.bytes - (old || 0);
      if (usage.count > ATTACHMENT_DRAFT_LIMITS.editors || usage.bytes > ATTACHMENT_DRAFT_LIMITS.deviceBytes) { tx.abort(); await done.catch(() => {}); throw failure("quota"); }
      tx.objectStore(DRAFTS).put(row);
      meta.put(row.bytes, row.key); meta.put(usage, "usage");
      await done;
    } catch (error) { if (error instanceof Error && error.message.startsWith("This browser")) throw error; throw storageFailure(error); }
    finally { db.close(); }
  });
}

/** Returns actual Files after a restart. Callers must compare draftIdentity with the freshly verified text baseline. */
export async function readAttachmentDraft(scope: AttachmentDraftScope, factory?: IDBFactory): Promise<AttachmentDraft | null> {
  const key = keyFor(scope), host = factoryFor(factory);
  return serialized(host, key, async () => {
    const db = await open(host);
    let stored: StoredDraft | undefined;
    try {
      const tx = db.transaction(DRAFTS, "readonly"), done = complete(tx);
      void done.catch(() => {});
      stored = await request<StoredDraft | undefined>(tx.objectStore(DRAFTS).get(key));
      await done;
    } catch (error) { throw storageFailure(error); }
    finally { db.close(); }
    if (!stored) return null;
    try {
      if (stored.version !== 1 || keyFor(stored) !== key || stored.key !== key || !Array.isArray(stored.files)
        || stored.files.length > ATTACHMENT_DRAFT_LIMITS.files || !Number.isSafeInteger(stored.bytes) || stored.bytes < 0) throw failure("corrupt");
      const restored: AttachmentDraft = { draftIdentity: stored.draftIdentity,
        files: stored.files.map(file => {
          if (!(file.blob instanceof Blob) || file.blob.type !== file.type || typeof file.name !== "string"
            || !Number.isSafeInteger(file.lastModified) || file.lastModified < 0) throw failure("corrupt");
          return { file: new File([file.blob], file.name, { type: file.type, lastModified: file.lastModified }), uploadId: file.uploadId };
        }), ...(stored.uploads ? { uploads: stored.uploads } : {}) };
      const normalized = normalize(scope, restored);
      if (normalized.bytes !== stored.bytes) throw failure("corrupt");
      return { draftIdentity: normalized.draftIdentity, files: restored.files, ...(normalized.uploads ? { uploads: normalized.uploads } : {}) };
    } catch { throw failure("corrupt"); }
  });
}

/** Invoke only for an explicit removal/discard or a confirmed upload/submission. Signout retains owner-scoped drafts. */
export async function clearAttachmentDraft(scope: AttachmentDraftScope, factory?: IDBFactory): Promise<void> {
  const key = keyFor(scope), host = factoryFor(factory);
  return serialized(host, key, async () => {
    const db = await open(host);
    try {
      const tx = db.transaction([DRAFTS, METADATA], "readwrite"), done = complete(tx);
      void done.catch(() => {});
      const meta = tx.objectStore(METADATA);
      const [old, stored] = await Promise.all([request<number | undefined>(meta.get(key)), request<Usage | undefined>(meta.get("usage"))]);
      if (old !== undefined) {
        const usage = stored || { count: 1, bytes: old };
        meta.put({ count: Math.max(0, usage.count - 1), bytes: Math.max(0, usage.bytes - old) }, "usage");
      }
      tx.objectStore(DRAFTS).delete(key); meta.delete(key);
      await done;
    } catch (error) { throw storageFailure(error); }
    finally { db.close(); }
  });
}
