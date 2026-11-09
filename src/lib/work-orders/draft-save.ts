export type DraftFields = {
  staff_first_name: string;
  location_id: string;
  issue: string;
  notes: string;
  asset_id: string | null;
  asset_name: string;
  category: string;
  priority: string;
};

type DraftFieldValues = { [K in keyof DraftFields]?: DraftFields[K] | null };
export type SavedDraft = DraftFieldValues & { id: string; revision: number };
export type PendingDraftSave = {
  method: "POST" | "PATCH";
  fields: DraftFields;
  id: string;
  revision?: number;
  uncertain?: boolean;
};

export function draftFieldsKey(fields: DraftFieldValues) {
  return JSON.stringify((["staff_first_name", "location_id", "issue", "notes", "asset_id", "asset_name", "category", "priority"] as const)
    .map(key => String(fields[key] ?? "").trim()));
}

/** Compare exactly the fields the draft endpoint normalizes and stores. */
export function sameDraftFields(a: DraftFieldValues, b: DraftFieldValues) {
  return draftFieldsKey(a) === draftFieldsKey(b);
}

/** Apply a confirmed server row without refetching or exposing another owner's draft. */
export function mergeConfirmedOwnDraft<T extends { id: string; created_by: string; creator_name?: string | null; can_edit?: boolean; can_delete?: boolean }>(
  drafts: T[], saved: T, ownerId: string, ownerName: string | null,
): T[] {
  if (saved.created_by !== ownerId) return drafts;
  const previous = drafts.find(draft => draft.id === saved.id);
  const merged = { creator_name: ownerName || 'Unknown User', can_edit: true, can_delete: true, ...previous, ...saved } as T;
  return [merged, ...drafts.filter(draft => draft.id !== saved.id)].slice(0, 100);
}

/** Do not apply or return a response after the session has changed in flight. */
export async function guardedDraftRequest(check: () => Promise<string>, request: (token: string) => Promise<Response>) {
  const token = await check();
  const response = await request(token);
  await check();
  return response;
}

/**
 * Keep an uncertain request intact until it is confirmed. A retry replays its
 * original snapshot before applying newer edits, so an idempotency key never
 * identifies two different payloads.
 */
export async function saveDraftWithRecovery(options: {
  fields: DraftFields;
  active: { id: string; revision: number } | null;
  pending: { current: PendingDraftSave | null };
  newId: () => string;
  send: (method: "POST" | "PATCH", body: Record<string, unknown>) => Promise<Response>;
  read: (id: string) => Promise<SavedDraft | null>;
  confirmed: (draft: SavedDraft) => void;
  isCurrent?: () => boolean;
}): Promise<SavedDraft> {
  const { fields, pending } = options;
  const checkCurrent = () => { if (options.isCurrent && !options.isCurrent()) throw new Error("Account changed"); };
  let current = options.active;
  let next = pending.current;
  if (!next) next = current
    ? { method: "PATCH", fields: { ...fields }, id: current.id, revision: current.revision }
    : { method: "POST", fields: { ...fields }, id: options.newId() };

  while (next) {
    const attempt: PendingDraftSave = next;
    checkCurrent();
    pending.current = attempt;
    const body = attempt.method === "POST"
      ? { ...attempt.fields, creation_id: attempt.id }
      : { ...attempt.fields, id: attempt.id, expected_revision: attempt.revision };
    let response: Response;
    try {
      response = await options.send(attempt.method, body);
    } catch {
      checkCurrent();
      if (pending.current !== attempt) throw new Error("Account changed");
      attempt.uncertain = true;
      throw new Error("The draft save could not be confirmed. Your text is still here. Retry Save Draft before leaving; check Saved Drafts before starting over.");
    }
    const payload = await response.json().catch(() => ({}));
    checkCurrent();
    if (pending.current !== attempt) throw new Error("Account changed");
    let saved = response.ok ? payload.draft as SavedDraft | undefined : undefined;
    let remote: SavedDraft | null = null;
    if (!response.ok && response.status === 409 && attempt.method === "PATCH" && attempt.uncertain) {
      // The earlier PATCH may have committed before its response was lost.
      // Only accept the exact next revision and matching normalized values.
      try {
        remote = await options.read(attempt.id);
        if (remote && remote.revision === (attempt.revision ?? -1) + 1 && sameDraftFields(remote, attempt.fields)) saved = remote;
      } catch { /* Preserve the pending snapshot if the read cannot be confirmed. */ }
      checkCurrent();
      if (pending.current !== attempt) throw new Error("Account changed");
      if (attempt.uncertain && !remote) throw new Error("A previous draft save is still unconfirmed. Your text is here; retry when the saved draft can be checked.");
    }
    if (!saved || typeof saved.id !== "string" || saved.id !== attempt.id || !Number.isSafeInteger(saved.revision)) {
      if (!response.ok && response.status >= 400 && response.status < 500 && response.status !== 409 && !attempt.uncertain) pending.current = null;
      // A conflicting PATCH cannot be replayed safely; allow the user to
      // explicitly load the current draft after preserving their text.
      if (response.status === 409 && attempt.method === "PATCH") pending.current = null;
      if (response.status === 409) throw new Error("This draft may have changed or a previous save may have succeeded. Your text is still here; copy it, then reload the saved draft and compare before saving again.");
      if (attempt.uncertain) throw new Error("A previous draft save is still unconfirmed. Your text is here; check Saved Drafts before starting over to avoid a duplicate.");
      if (!response.ok && response.status < 500) throw new Error(typeof payload.error === "string" ? payload.error : "Draft could not be saved. Your text is still here.");
      attempt.uncertain = true;
      throw new Error("The draft save could not be confirmed. Your text is still here. Retry Save Draft before leaving; check Saved Drafts before starting over.");
    }
    pending.current = null;
    current = { id: saved.id, revision: saved.revision };
    options.confirmed(saved);
    next = sameDraftFields(attempt.fields, fields) ? null : { method: "PATCH", fields: { ...fields }, id: current.id, revision: current.revision };
    if (!next) return saved;
  }
  throw new Error("Draft could not be saved. Your text is still here.");
}
