import test from 'node:test';
import assert from 'node:assert/strict';
import { NotepadSync, NotepadSyncError } from '../src/lib/notepad-sync.ts';
import { recoverNotepadDeviceDrafts } from '../src/lib/notepad-device-drafts.ts';
import { noteStorageKey } from '../src/lib/general-notes.ts';
const scope = { hotelId: 'property', userId: 'person' };
const document = (content = 'First') => ({ title: 'Project', content: `<p>${content}</p>`, audience: { all: false, roles: [], people: [] }, priority: 'Normal', fontSize: 16, fontFamily: 'Arial', titleFontFamily: 'Georgia', ink: [], itemThreads: {}, attachments: [] });
const note = (content = 'First', revision = 1) => ({ ...document(content), id: 'a', authorId: scope.userId, createdAt: '2026-11-23T12:00:00Z', updatedAt: '2026-11-23T12:00:00Z', revision });
function fixture() {
  const values = new Map(), records = new Map(), changes = new Map(), writes = [], orders = [];
  let delay = null, orderDelay = null, lose = false;
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const data = () => ({ ...scope, people: [], roles: [], notes: [...records.values()], order: [...records.keys()], legacyAliases: {} });
  const transport = {
    write: async pending => {
      writes.push(structuredClone(pending));
      if (delay) await delay;
      if (changes.has(pending.changeId)) return changes.get(pending.changeId);
      const prior = records.get(pending.id);
      if ((prior?.revision ?? null) !== pending.expectedRevision || (prior?.revision === 0 && prior.legacyVersion && prior.legacyVersion !== pending.expectedLegacyVersion)) throw new NotepadSyncError('Conflict', 409);
      const revision = (prior?.revision || 0) + 1;
      const next = pending.document ? { ...(prior || note('', 0)), ...pending.document, id: pending.id, revision } : null;
      if (next) records.set(pending.id, next); else records.delete(pending.id);
      const result = { note: next, revision }; changes.set(pending.changeId, result);
      if (lose) { lose = false; throw Error('Lost acknowledgement'); }
      return result;
    },
    order: async ids => { orders.push([...ids]); if (orderDelay) await orderDelay; },
  };
  const make = (session = scope) => new NotepadSync(session, storage, transport, 60_000);
  return { values, storage, records, writes, orders, data, make, delay: value => { delay = value; }, orderDelay: value => { orderDelay = value; }, lose: () => { lose = true; } };
}
test('outbox protects immediately, a boundary flush drains newer edits behind an in-flight save', async () => {
  const f = fixture(), s = f.make(); s.restore(f.data());
  let release; f.delay(new Promise(resolve => { release = resolve; }));
  s.queue('a', document('One'), 1, null);
  assert.match([...f.values.values()][0], /One/);
  const first = s.flush('a'); s.queue('a', document('Two'), 2, null);
  const boundary = s.flushAll(); release(); await Promise.all([first, boundary]);
  assert.equal(f.records.get('a').content, '<p>Two</p>');
  assert.deepEqual(f.writes.map(write => write.expectedRevision), [null, 1]);
  assert.equal(s.hasPending, false); s.stop();
});
test('background revision discovery never rebases the still-visible older document', async () => {
  const f = fixture(); f.records.set('a', note('Original', 1)); const s = f.make(); s.restore(f.data());
  f.records.set('a', note('Other person', 2)); s.remote(f.data());
  s.queue('a', document('Local edit of version 1'), 1, 1); await s.flushAll();
  assert.equal(f.writes[0].expectedRevision, 1); assert.ok(s.conflicts.has('a'));
  assert.equal(f.records.get('a').content, '<p>Other person</p>'); assert.match(s.drafts(), /Local edit/); s.stop();
});
test('recovery retries a lost acknowledgement with the same mutation identity before declaring conflict', async () => {
  const f = fixture(), s = f.make(); s.restore(f.data()); s.queue('a', document('Recovered'), 1, null); f.lose();
  const changeId = s.pending.get('a').changeId; await s.flushAll(); assert.equal(s.pending.size, 1); s.stop();
  const recovered = f.make(); recovered.restore(f.data()); assert.equal(recovered.conflicts.size, 0);
  await recovered.flushAll(); assert.equal(recovered.pending.size, 0); assert.equal(f.records.get('a').revision, 1);
  assert.equal(f.writes[1].changeId, changeId); recovered.stop();
});
test('a second sidebar reorder drains behind its first request and waits for new note creation', async () => {
  const f = fixture(), s = f.make(); s.restore(f.data()); s.queue('a', document(), 1, null); s.queueOrder(['a']); assert.equal(f.orders.length, 0);
  let release; f.orderDelay(new Promise(resolve => { release = resolve; }));
  const flight = s.flushAll(); await new Promise(resolve => setImmediate(resolve));
  s.queueOrder(['a', 'b']); release(); await flight;
  assert.deepEqual(f.orders, [['a'], ['a', 'b']]); assert.equal(s.hasPending, false); s.stop();
});
test('outboxes are account/property scoped and corrupt originals remain recoverable after later edits', () => {
  const f = fixture(), key = 'cmpri:notepad:outbox:v1:property:person'; f.values.set(key, '{broken original');
  const s = f.make(); s.restore(f.data()); s.queue('a', document('New draft'), 1, null);
  assert.equal(JSON.parse(f.values.get(key)).unreadableOutbox, '{broken original');
  const other = f.make({ hotelId: 'property', userId: 'someone-else' }); other.restore({ ...f.data(), userId: 'someone-else' }); assert.equal(other.pending.size, 0);
  s.stop(); other.stop();
});
const old = (text = 'Old draft') => ({ id: 'a', title: 'Old note', text, fontSize: 16, strokes: [], revision: 1, updated: 1795435200000 });
test('device-only legacy notes transfer once, preserve original storage, and do not reappear after deletion', async () => {
  const f = fixture(), key = noteStorageKey(scope), original = JSON.stringify([old()]); f.storage.setItem(key, original);
  const s = f.make(), data = f.data(); const recovered = await recoverNotepadDeviceDrafts(data, s.restore(data), s, f.storage);
  assert.match(recovered.notes[0].content, /Old draft/); await s.flushAll(); assert.equal(f.storage.getItem(key), original);
  s.queue('a', null, 2, 1); await s.flushAll(); s.stop();
  const reopen = f.make(), fresh = f.data(); const result = await recoverNotepadDeviceDrafts(fresh, reopen.restore(fresh), reopen, f.storage);
  assert.equal(reopen.pending.size, 0); assert.equal(result.notes.length, 0); reopen.stop();
});
test('a stale legacy outbox becomes a protected conflict instead of overwriting its Notepad replacement', async () => {
  const f = fixture(), key = noteStorageKey(scope); f.records.set('a', note('New shared work', 3));
  f.storage.setItem(key + ':outbox', JSON.stringify([{ note: old('Unsaved older work'), expectedRevision: 1 }]));
  const s = f.make(), data = f.data(); await recoverNotepadDeviceDrafts(data, s.restore(data), s, f.storage); await s.flushAll();
  assert.ok(s.conflicts.has('a')); assert.equal(f.writes.length, 0); assert.match(s.drafts(), /Unsaved older work/);
  s.discardConflicts(); s.stop(); const reopened = f.make(); await recoverNotepadDeviceDrafts(data, reopened.restore(data), reopened, f.storage); assert.equal(reopened.pending.size, 0); reopened.stop();
});
test('legacy dirty work imports automatically only against the untouched matching legacy revision', async () => {
  const f = fixture(), key = noteStorageKey(scope); f.records.set('a', { ...note('Server legacy', 0), legacySource: 'general', legacyRevision: 1 });
  f.storage.setItem(key + ':outbox', JSON.stringify([{ note: old('Still pending'), expectedRevision: 1 }]));
  const s = f.make(), data = f.data(); await recoverNotepadDeviceDrafts(data, s.restore(data), s, f.storage); await s.flushAll();
  assert.equal(s.conflicts.size, 0); assert.match(f.records.get('a').content, /Still pending/); assert.equal(f.writes[0].expectedRevision, 0); s.stop();
});

test('a first legacy save carries the originally displayed source version through outbox recovery', async () => {
  const f = fixture(); f.records.set('a', { ...note('Legacy v1', 0), legacySource: 'general', legacyVersion: 'general:1' });
  const s = f.make(); s.restore(f.data()); s.queue('a', document('My edit of v1'), 1, 0, 'general:1'); s.stop();
  f.records.set('a', { ...note('Legacy v2', 0), legacySource: 'general', legacyVersion: 'general:2' });
  const recovered = f.make(); recovered.restore(f.data()); await recovered.flushAll();
  assert.equal(f.writes[0].expectedLegacyVersion, 'general:1'); assert.ok(recovered.conflicts.has('a'));
  assert.equal(f.records.get('a').content, '<p>Legacy v2</p>'); recovered.stop();
});
