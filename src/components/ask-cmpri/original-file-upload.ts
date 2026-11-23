"use client";

import { ASK_FILE_LIMIT, type AskFileDescriptor, type AskStagedFile } from "../../lib/ask-cmpri/files";

type Authorization = { scope: string; headers: Record<string, string> };
type Authorize = (signal?: AbortSignal, expected?: string) => Promise<Authorization>;
type Entry = {
  original: File; scope: string; controller: AbortController; descriptor?: AskFileDescriptor;
  auth?: Authorization; staged?: AskStagedFile; promise?: Promise<AskStagedFile>; cleanup?: Promise<void>;
  retained?: boolean;
};
const endpoint = "/api/ask-cmpri/files";

function sameDescriptor(value: unknown, expected: AskFileDescriptor): value is AskFileDescriptor {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Record<string, unknown>;
  return (["id", "name", "type", "size", "sha256"] as const).every(key => descriptor[key] === expected[key]);
}

/** Holds only originals explicitly selected for the current Ask conversation. */
export function createAskOriginalFileStore() {
  const entries = new Set<Entry>();
  function remove(entry: Entry): Promise<void> {
    entry.retained = false;
    entries.delete(entry);
    entry.controller.abort();
    if (!entry.auth || !entry.descriptor) return Promise.resolve();
    // Cleanup retains the original actor's bearer, never a newly signed-in account.
    // Revoked/expired sessions leave the server's private retention cleanup in charge.
    entry.cleanup ??= fetch(endpoint, {
      method: "DELETE", headers: { ...entry.auth.headers, "Content-Type": "application/json" },
      body: JSON.stringify(entry.staged ? { token: entry.staged.token } : { descriptor: entry.descriptor }),
      cache: "no-store", keepalive: true, signal: AbortSignal.timeout(5000),
    }).then(() => {}).catch(() => {});
    return entry.cleanup;
  }

  async function upload(entry: Entry, authorize: Authorize): Promise<AskStagedFile> {
    const { original, scope, controller } = entry;
    const signal = controller.signal;
    try {
      signal.throwIfAborted();
      if (!original.size || original.size > ASK_FILE_LIMIT || !original.name || original.name.length > 255) {
        throw new Error("Choose a nonempty file up to 100 MB with a name of 255 characters or less.");
      }
      const digest = await crypto.subtle.digest("SHA-256", await original.arrayBuffer());
      signal.throwIfAborted();
      const descriptor: AskFileDescriptor = {
        id: crypto.randomUUID(), name: original.name, type: original.type || "application/octet-stream", size: original.size,
        sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
      };
      entry.descriptor = descriptor;
      const authorized = await authorize(signal, scope);
      signal.throwIfAborted();
      if (!scope || authorized.scope !== scope) throw new Error("The file's CMPRI account changed.");
      entry.auth = authorized;
      const preparedResponse = await fetch(endpoint, {
        method: "POST", headers: { ...entry.auth.headers, "Content-Type": "application/json" },
        body: JSON.stringify(descriptor), cache: "no-store", signal,
      });
      const prepared = await preparedResponse.json().catch(() => null) as { descriptor?: unknown; signedUrl?: string; contentType?: string } | null;
      signal.throwIfAborted();
      if (!preparedResponse.ok || !prepared || !sameDescriptor(prepared.descriptor, descriptor)
        || prepared.contentType !== descriptor.type || typeof prepared.signedUrl !== "string") {
        throw new Error("The original file could not be prepared for Ask CMPRI.");
      }
      const signedUrl = new URL(prepared.signedUrl);
      if (signedUrl.protocol !== "https:" || signedUrl.username || signedUrl.password
        || !signedUrl.pathname.startsWith("/storage/v1/object/upload/sign/") || !signedUrl.searchParams.get("token")) {
        throw new Error("The original file upload address is invalid.");
      }
      const sent = await fetch(signedUrl.href, {
        method: "PUT", headers: { "Content-Type": prepared.contentType, "x-upsert": "false" }, body: original,
        credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal,
      });
      signal.throwIfAborted();
      if (!sent.ok) throw new Error("The original file could not be uploaded. Select it again to retry.");
      const current = await authorize(signal, scope);
      signal.throwIfAborted();
      if (current.scope !== scope) throw new Error("The file's CMPRI account changed.");
      entry.auth = current;
      const finishedResponse = await fetch(endpoint, {
        method: "PUT", headers: { ...current.headers, "Content-Type": "application/json" },
        body: JSON.stringify(descriptor), cache: "no-store", signal,
      });
      const finished = await finishedResponse.json().catch(() => null) as { file?: AskStagedFile } | null;
      signal.throwIfAborted();
      if (!finishedResponse.ok || !sameDescriptor(finished?.file, descriptor) || typeof finished?.file?.token !== "string"
        || !finished.file.token || !Number.isSafeInteger(finished.file.expiresAt) || finished.file.expiresAt <= Date.now()) {
        throw new Error("The original file upload could not be verified.");
      }
      entry.staged = finished.file;
      const verified = await authorize(signal, scope);
      signal.throwIfAborted();
      if (verified.scope !== scope) throw new Error("The file's CMPRI account changed.");
      entry.auth = verified;
      return entry.staged;
    } catch (error) {
      if (!entry.retained) await remove(entry);
      throw error;
    }
  }

  return {
    async stage(original: File, scope: string, authorize: Authorize, signal: AbortSignal): Promise<AskStagedFile> {
      signal.throwIfAborted();
      let entry = [...entries].find(value => value.original === original && value.scope === scope && !value.controller.signal.aborted);
      if (entry?.staged && entry.staged.expiresAt <= Date.now() + 30_000) { await remove(entry); entry = undefined; }
      signal.throwIfAborted();
      if (entry?.staged) return entry.staged;
      if (!entry) {
        entry = { original, scope, controller: new AbortController() };
        entries.add(entry);
        entry.promise = upload(entry, authorize);
      }
      const current = entry;
      const abort = () => current.controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      try { return await current.promise!; }
      finally { signal.removeEventListener("abort", abort); }
    },
    remove(original: File) { return Promise.all([...entries].filter(entry => entry.original === original).map(remove)).then(() => {}); },
    clear({ revokeFinalized = false }: { revokeFinalized?: boolean } = {}) {
      return Promise.all([...entries].map(entry => {
        if (!revokeFinalized && entry.staged) {
          // History retains the signed actor-bound reference until its original 24h expiry.
          // Closing a window or starting another search does not delete that retained evidence.
          entry.retained = true;
          entries.delete(entry);
          entry.controller.abort();
          return Promise.resolve();
        }
        return remove(entry);
      })).then(() => {});
    },
  };
}
