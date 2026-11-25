import { noteStorageKey, parseGeneralNotes, type GeneralNote } from './general-notes';
import { legacyGeneralNote } from './notepad-legacy';
import { notepadDocument, type NotepadBootstrap } from './notepad';
import type { NotepadSync } from './notepad-sync';

type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type OldDraft = { note: GeneralNote; expectedRevision: number | null; dirty: boolean };

/** Leave original Notes storage intact; claim a draft only after its durable transfer. */
export async function recoverNotepadDeviceDrafts(data: NotepadBootstrap, restored: NotepadBootstrap, sync: NotepadSync, storage: StoragePort): Promise<NotepadBootstrap> {
  const key = noteStorageKey(data), markerKey = key + ':notepad-imported:v1';
  const local = parseGeneralNotes(storage.getItem(key));
  const outbox: unknown = JSON.parse(storage.getItem(key + ':outbox') || '[]');
  if (!Array.isArray(outbox)) throw Error('Older Notes drafts could not be read.');
  const candidates = new Map<string, OldDraft>(local.map(note => [note.id, { note, expectedRevision: null, dirty: false }]));
  for (const draft of outbox) {
    parseGeneralNotes(JSON.stringify([draft.note]));
    if (!(draft.expectedRevision === null || (Number.isSafeInteger(draft.expectedRevision) && draft.expectedRevision >= 0))) throw Error('Older Notes draft revision is invalid.');
    candidates.set(draft.note.id, { ...draft, dirty: true });
  }
  const claimed = JSON.parse(storage.getItem(markerKey) || '{}');
  if (!claimed || typeof claimed !== 'object' || Array.isArray(claimed)) throw Error('Older Notes recovery state could not be read.');
  let notes = restored.notes;
  for (const draft of candidates.values()) {
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ note: draft.note, expectedRevision: draft.expectedRevision }))))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (claimed[draft.note.id] === fingerprint) continue;
    const existing = data.notes.find(note => note.id === draft.note.id);
    if (!draft.dirty && existing) continue; // A cache is not an unsaved edit.
    if (sync.pending.has(draft.note.id)) continue;
    const matchesLegacy = existing?.revision === 0 && existing.legacySource === 'general' && draft.expectedRevision !== null && existing.legacyRevision === draft.expectedRevision;
    const conflict = existing ? !matchesLegacy : draft.expectedRevision !== null;
    const converted = legacyGeneralNote(draft.note.id, data.userId, draft.note, new Date(draft.note.updated).toISOString());
    const durable = sync.recover(converted.id, notepadDocument(converted), 1, existing?.revision ?? null, conflict, existing?.legacyVersion ?? null);
    notes = notes.filter(note => note.id !== converted.id).concat({ ...converted, ...(existing ? { revision: existing.revision, createdAt: existing.createdAt, authorId: existing.authorId } : {}) });
    if (durable) { claimed[draft.note.id] = fingerprint; storage.setItem(markerKey, JSON.stringify(claimed)); }
  }
  return { ...restored, notes };
}
