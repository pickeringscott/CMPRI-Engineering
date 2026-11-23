import type { AskContext, AskResponse } from "@/lib/ask-cmpri/types";

export type AskTurn = {
  id: string;
  question: string;
  result: AskResponse;
  attachments?: { file: File; uploadId: string }[];
  attachmentNames?: string[];
  outcome?: string;
  savedOrder?: { id: string; displayId: string };
  waiting?: boolean;
};

export type AskHistoryEntry = {
  id: string;
  question: string;
  date: number;
  turns: AskTurn[];
  context?: AskContext;
  kept?: boolean;
};

type HistoryRecord = AskHistoryEntry | { deleted: true };
const cacheAge = 7 * 86_400_000;
const recentLimit = 80;
const oldKey = (scope: string) => "cmpri:ask-history:v1:" + scope;
const prefix = (scope: string) => "cmpri:ask-history:v2:" + encodeURIComponent(scope) + ":";
const recordKey = (scope: string, id: string) => prefix(scope) + encodeURIComponent(id);
const memory = new Map<string, HistoryRecord>();
const keptOverrides = new Map<string, boolean>();

export function savedAskTurn(turn: AskTurn): AskTurn {
  const { proposal: _proposal, ...result } = turn.result;
  void _proposal;
  return {
    id: turn.id, question: turn.question, result, attachmentNames: turn.attachmentNames,
    outcome: turn.outcome, waiting: turn.waiting,
  };
}

function validEntry(value: unknown): value is AskHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<AskHistoryEntry>;
  return typeof entry.id === "string" && typeof entry.date === "number" &&
    typeof entry.question === "string" && Array.isArray(entry.turns);
}

function parseRecord(raw: string | null): HistoryRecord | undefined {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    if (validEntry(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && "deleted" in parsed && parsed.deleted === true) return { deleted: true };
  } catch {
    // A malformed entry does not prevent restoring the rest of History.
  }
}

function snapshot(scope: string) {
  const entries = new Map<string, HistoryRecord>();
  const legacy = new Set<string>();
  const deleted = new Set<string>();
  const kept = new Map<string, boolean>();
  const scopePrefix = prefix(scope);
  try {
    const previous: unknown = JSON.parse(localStorage.getItem(oldKey(scope)) ?? "null");
    if (Array.isArray(previous)) {
      for (const entry of previous.filter(validEntry)) {
        entries.set(entry.id, entry);
        legacy.add(entry.id);
      }
    }
  } catch {
    // The browser may have disabled persistent storage.
  }
  function apply(key: string, record?: HistoryRecord) {
    if (!key.startsWith(scopePrefix) || !record) return;
    const id = key.slice(scopePrefix.length);
    if (id.endsWith("::deleted")) deleted.add(decodeURIComponent(id.slice(0, -9)));
    else entries.set(decodeURIComponent(id), record);
  }
  function applyKept(key: string, value: string | boolean | null) {
    if (key.startsWith(scopePrefix) && key.endsWith("::kept") && value !== null) {
      kept.set(decodeURIComponent(key.slice(scopePrefix.length, -6)), value === true || value === "1");
    }
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(scopePrefix)) {
        const raw = localStorage.getItem(key);
        if (key.endsWith("::kept")) applyKept(key, raw);
        else apply(key, parseRecord(raw));
      }
    }
  } catch {
    // Session-only records are still available in memory.
  }
  for (const [key, record] of memory) apply(key, record);
  for (const [key, value] of keptOverrides) applyKept(key, value);
  for (const [id, value] of kept) {
    const entry = entries.get(id);
    if (validEntry(entry)) entries.set(id, { ...entry, kept: value });
  }
  for (const id of deleted) entries.set(id, { deleted: true });
  return { entries, legacy };
}

function keptAndRecent(records: Iterable<HistoryRecord>, now: number) {
  let count = 0;
  return Array.from(records).filter(validEntry).sort((left, right) => right.date - left.date)
    .filter((entry) => entry.kept || (entry.date >= now - cacheAge && count++ < recentLimit));
}

export function readAskHistory(scope: string) {
  return keptAndRecent(snapshot(scope).entries.values(), Date.now());
}

export function askHistoryStorageChanged(scope: string, event: StorageEvent) {
  return event.key === null || event.key === oldKey(scope) || event.key.startsWith(prefix(scope));
}

function write(key: string, value: HistoryRecord) {
  // Separate records keep independent tabs from overwriting each other’s entries.
  try {
    localStorage.setItem(key, JSON.stringify(value));
    memory.delete(key);
  } catch {
    memory.set(key, value);
  }
}

function prune(scope: string) {
  const { entries: records, legacy } = snapshot(scope);
  const retained = new Set(keptAndRecent(records.values(), Date.now()).map((entry) => entry.id));
  for (const [id, entry] of records) {
    if (validEntry(entry) && !retained.has(id)) {
      const key = recordKey(scope, id);
      if (legacy.has(id)) write(key + "::deleted", { deleted: true });
      memory.delete(key);
      try { localStorage.removeItem(key); } catch { /* The browser may block storage. */ }
    }
  }
}

export function updateAskHistoryEntry(scope: string, id: string, change: (current?: AskHistoryEntry) => AskHistoryEntry | undefined) {
  const previous = snapshot(scope).entries.get(id);
  if (previous && !validEntry(previous)) return readAskHistory(scope);
  const next = change(previous);
  if (next) {
    write(recordKey(scope, id), { ...next, turns: next.turns.map(savedAskTurn) });
    prune(scope);
  }
  return readAskHistory(scope);
}

export function deleteAskHistoryEntry(scope: string, id: string) {
  const key = recordKey(scope, id);
  write(key + "::deleted", { deleted: true });
  memory.delete(key);
  keptOverrides.delete(key + "::kept");
  try {
    localStorage.removeItem(key);
    localStorage.removeItem(key + "::kept");
  } catch { /* The tombstone still suppresses the record in this tab. */ }
  return readAskHistory(scope);
}

export function toggleAskHistoryKept(scope: string, id: string) {
  const current = snapshot(scope).entries.get(id);
  if (!validEntry(current)) return readAskHistory(scope);
  const key = recordKey(scope, id) + "::kept";
  try {
    localStorage.setItem(key, current.kept ? "0" : "1");
    keptOverrides.delete(key);
  } catch {
    keptOverrides.set(key, !current.kept);
  }
  return readAskHistory(scope);
}
