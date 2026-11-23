import { notepadDocument, type NotepadBootstrap, type NotepadDocument, type NotepadNote } from './notepad';

export type NotepadPending = { id: string; document: NotepadDocument | null; expectedRevision: number | null; expectedLegacyVersion?: string | null; changeId: string; sequence: number };
export class NotepadSyncError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Transport = {
  write: (pending: NotepadPending, keepalive?: boolean) => Promise<{ note: NotepadNote | null; revision: number }>;
  order: (ids: string[]) => Promise<void>;
};
export type NotepadSyncState = { message: string; pending: number; conflictIds: string[]; error: boolean };

/** Account/property-scoped outbox. A write always carries the revision its editor actually read. */
export class NotepadSync {
  readonly pending = new Map<string, NotepadPending>();
  readonly revisions = new Map<string, number>();
  private legacyVersions = new Map<string, string>();
  readonly conflicts = new Set<string>();
  onState: (state: NotepadSyncState) => void = () => {};
  onSaved: (id: string, sequence: number, note: NotepadNote | null, revision: number) => void = () => {};
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private flights = new Map<string, Promise<void>>();
  private pendingOrder: string[] | null = null;
  private orderFlight: Promise<void> | null = null;
  private stopped = false;
  private durable = true;
  private message = 'Saved';
  private failed = false;
  private recoveryRaw: string | null = null;
  private key: string;
  private scope: { hotelId: string; userId: string };
  private storage: StoragePort;
  private transport: Transport;
  private idleMs: number;

  constructor(scope: { hotelId: string; userId: string }, storage: StoragePort, transport: Transport, idleMs = 350) {
    this.scope = scope; this.storage = storage; this.transport = transport; this.idleMs = idleMs;
    this.key = `cmpri:notepad:outbox:v1:${scope.hotelId}:${scope.userId}`;
  }
  get hasPending() { return this.pending.size > 0 || this.pendingOrder !== null; }
  get isDurable() { return this.durable; }
  private emit() {
    const message = !this.durable ? 'Keep Notepad open: this browser could not protect the unsaved draft.'
      : this.recoveryRaw ? 'Older saved drafts could not be read. Download draft to recover their original data.' : this.message;
    if (!this.stopped) this.onState({ message, pending: this.pending.size + (this.pendingOrder ? 1 : 0), conflictIds: [...this.conflicts], error: this.failed || !this.durable || !!this.recoveryRaw });
  }
  private protect() {
    try { this.storage.setItem(this.key, this.drafts()); this.durable = true; }
    catch { this.durable = false; }
    this.emit();
  }
  restore(data: NotepadBootstrap): NotepadBootstrap {
    data.notes.forEach(note => { this.revisions.set(note.id, note.revision); if (note.legacyVersion) this.legacyVersions.set(note.id, note.legacyVersion); });
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(this.key);
      const saved = JSON.parse(raw || '{"notes":[],"order":null}');
      if (!Array.isArray(saved.notes)) throw Error('Invalid outbox');
      for (const pending of saved.notes as NotepadPending[]) {
        if (!pending || typeof pending.id !== 'string' || !Number.isSafeInteger(pending.sequence) || typeof pending.changeId !== 'string' || !(pending.expectedRevision === null || (Number.isSafeInteger(pending.expectedRevision) && pending.expectedRevision >= 0)) || !(pending.document === null || (pending.document && typeof pending.document.content === 'string' && pending.document.audience))) throw Error('Invalid draft');
      }
      for (const pending of saved.notes as NotepadPending[]) this.pending.set(pending.id, pending);
      if (Array.isArray(saved.order) && saved.order.every((id: unknown) => typeof id === 'string')) this.pendingOrder = saved.order;
      if (typeof saved.unreadableOutbox === 'string') this.recoveryRaw = saved.unreadableOutbox;
    } catch { this.recoveryRaw = raw || 'Browser storage could not be read.'; this.failed = true; this.emit(); return data; }
    // Let the server compare mutation IDs before declaring a conflict: the prior
    // request may have committed even if its acknowledgement never reached us.
    const notes = data.notes.filter(note => this.pending.get(note.id)?.document !== null).map(note => {
      const pending = this.pending.get(note.id);
      return pending?.document ? { ...note, ...pending.document } : note;
    });
    for (const pending of this.pending.values()) {
      if (pending.document && pending.expectedRevision === null && !notes.some(note => note.id === pending.id)) {
        notes.push({ ...pending.document, id: pending.id, authorId: this.scope.userId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0 });
      }
    }
    this.message = this.hasPending ? 'Saving recovered draft…' : 'Saved';
    this.emit();
    return { ...data, notes, order: this.pendingOrder || data.order };
  }
  queue(id: string, document: NotepadDocument | null, sequence: number, baseRevision?: number | null, expectedLegacyVersion?: string | null) {
    if (this.stopped) return;
    const prior = this.pending.get(id);
    const expectedRevision = prior ? prior.expectedRevision : baseRevision !== undefined ? baseRevision : this.revisions.get(id) ?? null;
    this.pending.set(id, { id, document: document ? notepadDocument(document) : null, expectedRevision, expectedLegacyVersion: prior ? prior.expectedLegacyVersion : expectedLegacyVersion !== undefined ? expectedLegacyVersion : this.legacyVersions.get(id) ?? null, changeId: crypto.randomUUID(), sequence });
    this.message = this.conflicts.has(id) ? 'This note changed elsewhere. Your draft is protected.' : 'Saving…';
    this.failed = this.conflicts.size > 0;
    this.protect();
    clearTimeout(this.timers.get(id));
    if (!this.conflicts.has(id)) this.timers.set(id, setTimeout(() => { this.timers.delete(id); void this.flush(id); }, this.idleMs));
  }
  /** Transfer an older Notes draft without rebasing stale content onto a newer server document. */
  recover(id: string, document: NotepadDocument, sequence: number, baseRevision: number | null, conflict = false, expectedLegacyVersion?: string | null) {
    if (this.stopped) return false;
    if (conflict) this.conflicts.add(id);
    this.queue(id, document, sequence, baseRevision, expectedLegacyVersion);
    return this.durable;
  }
  queueOrder(order: string[]) { if (this.stopped) return; this.pendingOrder = [...order]; this.protect(); void this.flushOrder(); }
  async flushOrder(): Promise<void> {
    if (this.orderFlight) return this.orderFlight;
    if (this.stopped || this.pending.size || !this.pendingOrder) return;
    const flight = (async () => {
      while (!this.stopped && !this.pending.size && this.pendingOrder) {
        const order = this.pendingOrder;
        try {
          await this.transport.order(order);
          if (this.stopped) return;
          if (this.pendingOrder === order) this.pendingOrder = null;
          this.message = this.hasPending ? 'Saving…' : 'Saved'; this.failed = this.conflicts.size > 0;
          this.protect();
        } catch (error) {
          if (!this.stopped) { this.message = error instanceof Error ? error.message : 'Sidebar order is saved locally. Reconnect to sync.'; this.failed = true; this.protect(); }
          break;
        }
      }
    })();
    this.orderFlight = flight;
    try { await flight; } finally { this.orderFlight = null; }
  }
  async flush(id: string, keepalive = false): Promise<void> {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    const running = this.flights.get(id); if (running) return running;
    if (this.stopped || this.conflicts.has(id) || !this.pending.has(id)) return;
    const flight = (async () => {
      while (!this.stopped && !this.conflicts.has(id)) {
        const pending = this.pending.get(id); if (!pending) break;
        try {
          const result = await this.transport.write(pending, keepalive);
          if (this.stopped) return;
          this.revisions.set(id, result.revision);
          const latest = this.pending.get(id);
          if (latest === pending) this.pending.delete(id);
          else if (latest) { latest.expectedRevision = result.revision; latest.expectedLegacyVersion = null; }
          this.onSaved(id, pending.sequence, result.note, result.revision);
          this.message = this.hasPending ? 'Saving…' : 'Saved'; this.failed = this.conflicts.size > 0;
          this.protect();
        } catch (error) {
          if (this.stopped) return;
          if (error instanceof NotepadSyncError && [403, 404, 409].includes(error.status)) this.conflicts.add(id);
          this.message = error instanceof Error ? error.message : 'Offline · Your draft is protected on this device.';
          this.failed = true; this.emit();
          break;
        }
      }
    })();
    this.flights.set(id, flight);
    try { await flight; } finally { this.flights.delete(id); }
    if (!this.pending.size) await this.flushOrder();
  }
  async flushAll(keepalive = false) { await Promise.all([...this.pending.keys()].map(id => this.flush(id, keepalive))); await this.flushOrder(); }
  remote(data: NotepadBootstrap): NotepadBootstrap {
    for (const note of data.notes) if (!this.pending.has(note.id)) { this.revisions.set(note.id, note.revision); if (note.legacyVersion) this.legacyVersions.set(note.id, note.legacyVersion); else this.legacyVersions.delete(note.id); }
    return data;
  }
  discardConflicts() {
    for (const id of this.conflicts) { this.pending.delete(id); clearTimeout(this.timers.get(id)); this.timers.delete(id); }
    this.conflicts.clear(); this.failed = false; this.message = 'Saved'; this.protect();
  }
  drafts() { return JSON.stringify({ notes: [...this.pending.values()], order: this.pendingOrder, ...(this.recoveryRaw ? { unreadableOutbox: this.recoveryRaw } : {}) }); }
  stop() { this.stopped = true; this.timers.forEach(timer => clearTimeout(timer)); this.timers.clear(); }
}
