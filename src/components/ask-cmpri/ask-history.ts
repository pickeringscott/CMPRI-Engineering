import type { AskContext, AskResponse } from "@/lib/ask-cmpri/types";

export type AskTurn = {
  id: string;
  question: string;
  result: AskResponse;
  attachments?: { file: File; uploadId: string }[];
  attachmentNames?: string[];
  outcome?: string;
  savedOrder?: { id: string; displayId: string };
};

export type AskHistoryEntry = {
  id: string;
  question: string;
  date: number;
  turns: AskTurn[];
  context?: AskContext;
  kept?: boolean;
};

const cacheAge = 7 * 86_400_000;
const storageKey = (scope: string) => "cmpri:ask-history:v1:" + scope;

export function recordAskHistoryEntry(entry: Omit<AskHistoryEntry, "date">): AskHistoryEntry {
  return { ...entry, date: Date.now() };
}

export function savedAskTurn(turn: AskTurn): AskTurn {
  const { proposal: _proposal, ...result } = turn.result;
  void _proposal;
  return { id: turn.id, question: turn.question, result, attachmentNames: turn.attachmentNames, outcome: turn.outcome };
}

export function readAskHistory(scope: string): AskHistoryEntry[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(scope)) || "[]");
    if (Array.isArray(value)) return value.filter(entry => entry && typeof entry.id === "string" && Array.isArray(entry.turns) &&
      typeof entry.date === "number" && (entry.kept || entry.date >= Date.now() - cacheAge));
  } catch { /* History can still be kept for this session. */ }
  return [];
}

export function writeAskHistory(scope: string, entries: AskHistoryEntry[]) {
  try { localStorage.setItem(storageKey(scope), JSON.stringify(entries.slice(0, 80))); }
  catch { /* The browser may not allow persistent local storage. */ }
}
