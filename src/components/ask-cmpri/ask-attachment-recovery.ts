import type { AskResponse } from "@/lib/ask-cmpri/types";
import type { AskTurn } from "./ask-history";

export type AskAttachmentRecovery = {
  id: string;
  scope: string;
  token: string;
  date: number;
  files: NonNullable<AskTurn["attachments"]>;
  order?: NonNullable<AskResponse["savedOrder"]>;
};

const storeName = "confirmations";
const retention = 7 * 86_400_000;
const memory = new Map<string, AskAttachmentRecovery>();
const keyFor = (scope: string, id: string) => `${scope}:${id}`;

export function makeAskAttachmentRecovery(record: Omit<AskAttachmentRecovery, "date">): AskAttachmentRecovery {
  return { ...record, date: Date.now() };
}

async function storage<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("cmpri-ask-attachment-recovery", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function saveAskAttachmentRecovery(record: AskAttachmentRecovery) {
  const key = keyFor(record.scope, record.id);
  memory.set(key, record);
  try {
    await storage("readwrite", (store) => store.put(record, key));
  } catch {
    // Browsers that deny or run out of IndexedDB can still retry in this tab.
  }
}

export async function removeAskAttachmentRecovery(scope: string, id: string) {
  const key = keyFor(scope, id);
  memory.delete(key);
  try { await storage("readwrite", (store) => store.delete(key)); } catch { /* The tab no longer holds a copy. */ }
}

export async function readAskAttachmentRecoveries(scope: string) {
  const records = new Map<string, AskAttachmentRecovery>();
  try {
    for (const record of await storage<AskAttachmentRecovery[]>("readonly", (store) => store.getAll())) {
      if (record?.scope === scope) records.set(record.id, record);
    }
  } catch { /* Use in-memory recoveries if browser storage is unavailable. */ }
  for (const record of memory.values()) if (record.scope === scope) records.set(record.id, record);
  const fresh = [];
  for (const record of records.values()) {
    if (Date.now() - record.date < retention) fresh.push(record);
    else void removeAskAttachmentRecovery(scope, record.id);
  }
  return fresh.sort((left, right) => right.date - left.date);
}
