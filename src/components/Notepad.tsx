"use client";

import { useEffect, useRef, useState } from 'react';
import { createClient, getValidSession } from '@/lib/supabase/client';
import { isNotesSessionRestart } from '@/lib/general-notes-session';
import { requestGiphy } from '@/lib/giphy';
import { STAFF_FILE_BUCKET, staffFileInput } from '@/lib/staff-note-media';
import { NotepadSync, NotepadSyncError, type NotepadSyncState } from '@/lib/notepad-sync';
import type { NotepadBootstrap, NotepadDocument } from '@/lib/notepad';
import { recoverNotepadDeviceDrafts } from '@/lib/notepad-device-drafts';
import { NOTEPAD_CLOSE_REQUEST, type NotepadCloseRequest } from '@/lib/ui/notepad-close';
import './notepad/notepad-host.css';

type Props = { targetNoteId?: string | null; onOpenWorkOrder?: (id: string) => void; compact?: boolean };
const CHANNEL = 'cmpri-notepad';
const EMPTY_STATE: NotepadSyncState = { message: '', pending: 0, conflictIds: [], error: false };

/** The approved HTML is the editor. This host supplies the authenticated CMPRI transport. */
export default function Notepad({ targetNoteId, onOpenWorkOrder, compact }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const sync = useRef<NotepadSync | null>(null);
  const target = useRef(targetNoteId);
  const openWorkOrder = useRef(onOpenWorkOrder);
  const send = useRef<(type: string, payload?: unknown) => void>(() => {});
  const reload = useRef<() => Promise<void>>(async () => {});
  const [source, setSource] = useState('');
  const [notice, setNotice] = useState('Loading Notepad…');
  const [state, setState] = useState<NotepadSyncState>(EMPTY_STATE);
  useEffect(() => { openWorkOrder.current = onOpenWorkOrder; }, [onOpenWorkOrder]);
  useEffect(() => { target.current = targetNoteId; send.current('select', { id: targetNoteId }); }, [targetNoteId]);

  useEffect(() => {
    let alive = true, ready = false, bootstrap: NotepadBootstrap | null = null, epoch = 0;
    let loading: Promise<void> | null = null, authorizedUserId: string | null = null;
    let closingRequested: (NotepadCloseRequest & { flushed: boolean; flushId: string }) | null = null;
    let subscription: ReturnType<ReturnType<typeof createClient>['channel']> | null = null;
    const client = createClient(), token = crypto.randomUUID();
    const controllers = new Set<AbortController>();
    const uploads = new Set<string>();
    const post = (type: string, payload?: unknown) => {
      if (alive) frame.current?.contentWindow?.postMessage({ channel: CHANNEL, token, type, payload }, window.location.origin);
    };
    send.current = post;
    const palette = () => {
      if (!host.current) return {};
      const style = getComputedStyle(host.current);
      return Object.fromEntries(['--cmpri-action-rgb', '--cmpri-modal-base', '--cmpri-modal-surface', '--cmpri-modal-text', '--cmpri-outline', '--cmpri-modal-muted', '--accent'].map(name => [name, style.getPropertyValue(name).trim()]).filter(([, value]) => value));
    };
    const authorize = async (scope = bootstrap) => {
      const version = epoch;
      const session = await getValidSession();
      if (!alive || version !== epoch || !session?.access_token || (scope && session.user.id !== scope.userId)
        || (authorizedUserId && session.user.id !== authorizedUserId)) throw new NotepadSyncError('Sign in again to save this account’s Notepad.', 401);
      authorizedUserId = session.user.id;
      return { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', ...(scope ? { 'X-CMPRI-Property': scope.hotelId } : {}) };
    };
    const request = async (path: string, options: RequestInit = {}, scope = bootstrap) => {
      const controller = new AbortController(); controllers.add(controller);
      try {
        const init = { ...options, headers: await authorize(scope), signal: controller.signal, cache: 'no-store' as RequestCache };
        let response = await fetch(path, init);
        if (await isNotesSessionRestart(response)) response = await fetch(path, init);
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new NotepadSyncError(result.error || 'Notepad could not be saved. Your draft remains on this device.', response.status);
        return result;
      } finally { controllers.delete(controller); }
    };
    const initializeFrame = () => {
      if (!ready || !bootstrap || !sync.current) return;
      post('initialize', { ...bootstrap, targetNoteId: target.current, palette: palette(), sequences: Object.fromEntries([...sync.current.pending].map(([id, draft]) => [id, draft.sequence])) });
      setNotice('');
    };
    const finishRequestedClose = () => {
      const request = closingRequested, coordinator = sync.current;
      if (!alive || !request?.flushed || !coordinator || uploads.size || coordinator.hasPending || coordinator.conflicts.size) return;
      closingRequested = null;
      request.onReady();
    };
    const flushEditorForClose = () => {
      if (!closingRequested) return;
      closingRequested.flushed = !ready;
      closingRequested.flushId = crypto.randomUUID();
      if (ready) post('flush', { requestId: closingRequested.flushId });
      else void sync.current?.flushAll().then(finishRequestedClose);
    };
    const resetSession = (userId: string | null, retry: boolean, message = 'Checking your CMPRI session…') => {
      epoch++; controllers.forEach(controller => controller.abort()); sync.current?.stop(); sync.current = null;
      if (subscription) { void client.removeChannel(subscription); subscription = null; }
      authorizedUserId = userId; bootstrap = null; loading = null; closingRequested = null; uploads.clear();
      post('clear'); setNotice(message); setState(EMPTY_STATE);
      if (retry && userId) queueMicrotask(() => { if (alive) void load(); });
    };
    const load = async () => {
      if (loading) return loading;
      const version = epoch;
      loading = (async () => {
        try {
          const data = await request('/api/notepad', {}, bootstrap) as NotepadBootstrap;
          // Authentication can change while the first GET is in flight, before
          // bootstrap exists. Recheck the actual current account before display.
          const session = await getValidSession();
          if (!alive || version !== epoch) return;
          if (!data.hotelId || !data.userId || !Array.isArray(data.notes)) throw Error('Notepad returned an incomplete session.');
          if (!session?.access_token || session.user.id !== data.userId) {
            resetSession(session?.user.id || null, true, session?.user.id ? 'Checking your CMPRI session…' : 'Sign in to open Notepad.');
            return;
          }
          authorizedUserId = data.userId;
          if (!bootstrap) {
            bootstrap = data;
            const scope = { hotelId: data.hotelId, userId: data.userId };
            const coordinator = new NotepadSync(scope, localStorage, {
              write: (pending, keepalive) => { const body = JSON.stringify({ id: pending.id, expectedRevision: pending.expectedRevision, expectedLegacyVersion: pending.expectedLegacyVersion, changeId: pending.changeId, document: pending.document }); return request('/api/notepad', { method: 'PUT', body, keepalive: keepalive && body.length < 50_000 }, data); },
              order: async order => { await request('/api/notepad', { method: 'PATCH', body: JSON.stringify({ order }) }, data); },
            });
            coordinator.onState = next => { if (alive && version === epoch) { setState(next); post('status', next); finishRequestedClose(); } };
            coordinator.onSaved = (id, sequence, note, revision) => { if (alive && version === epoch) post('saved', { id, sequence, note, revision }); };
            sync.current = coordinator;
            bootstrap = coordinator.restore(data);
            try {
              const recovered = await recoverNotepadDeviceDrafts(data, bootstrap, coordinator, localStorage);
              if (!alive || version !== epoch) return;
              bootstrap = recovered;
            } catch { if (alive && version === epoch) setState(current => ({ ...current, error: true, message: 'Some older device drafts could not be imported. Their original browser data is unchanged.' })); }
            if (!alive || version !== epoch) return;
            initializeFrame();
            void coordinator.flushAll();
            subscription = client.channel(`notepad:${data.hotelId}:${data.userId}:${token}`)
              .on('postgres_changes', { event: '*', schema: 'public', table: 'cmpri_resource_signals', filter: `recipient_user_id=eq.${data.userId}` }, change => {
                const row = change.new as { topic?: string };
                if (!document.hidden && row.topic === 'notepad') void load();
              }).subscribe(status => { if (status === 'SUBSCRIBED' && !document.hidden) void load(); });
          } else {
            bootstrap = sync.current?.remote(data) || data;
            post('remote', bootstrap);
          }
        } catch (error) {
          if (!alive || version !== epoch) return;
          const message = error instanceof Error ? error.message : 'Notepad could not be loaded.';
          if (error instanceof NotepadSyncError && [401, 403].includes(error.status)) {
            const session = await getValidSession().catch(() => null);
            if (!alive || version !== epoch) return;
            const userId = session?.user.id || null;
            resetSession(userId, !!userId && userId !== authorizedUserId, message);
            return;
          }
          if (!bootstrap) { setNotice(message); post('unavailable', { message }); }
          else { setState(current => ({ ...current, error: true, message })); post('status', { message, error: true }); }
        } finally { if (version === epoch) loading = null; }
      })();
      return loading;
    };
    reload.current = load;
    const mediaRequest = async (action: string, payload: Record<string, unknown>) => {
      const scope = bootstrap;
      if (!scope) throw Error('Sign in to use Notepad.');
      await authorize(scope);
      if (action === 'giphy') {
        if (Array.isArray(payload.ids)) {
          const ids = payload.ids.filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(id)).slice(0,50);
          if (!ids.length) return { gifs: [], total: 0 };
          return requestGiphy('', { ids: ids.join(',') });
        }
        const query = String(payload.query || '').slice(0,50), offset = Math.max(0, Math.min(5000, Number(payload.offset) || 0));
        return requestGiphy(query ? '/search' : '/trending', { limit: '50', offset: String(offset), ...(query ? { q: query, lang: 'en' } : {}) });
      }
      if (action === 'upload') {
        const file = payload.file as File;
        if (!(file instanceof File)) throw Error('Choose a file to attach.');
        const input = staffFileInput({ id: payload.id, name: file.name, type: file.type || 'application/octet-stream', size: file.size });
        if (!input) throw Error('Choose a file up to 100 MB with a valid name and type.');
        const prepared = await request('/api/notepad/uploads', { method: 'POST', body: JSON.stringify(input) }, scope);
        await authorize(scope);
        const uploaded = await client.storage.from(STAFF_FILE_BUCKET).uploadToSignedUrl(prepared.path, prepared.token, file, { contentType: input.type, upsert: false });
        if (uploaded.error) throw Error(uploaded.error.message || 'The file could not be uploaded.');
        const verified = await request('/api/notepad/uploads', { method: 'PUT', body: JSON.stringify({ id: input.id }) }, scope);
        if (!verified.ready) throw Error('The upload could not be verified.');
        return { ...input, kind: 'file', ...(verified.url ? { url: verified.url } : {}) };
      }
      if (action === 'attachment') {
        const coordinator = sync.current;
        if (typeof payload.noteId === 'string') {
          await coordinator?.flush(payload.noteId);
          if (coordinator?.pending.has(payload.noteId) || coordinator?.conflicts.has(payload.noteId)) {
            throw Error('This attachment cannot open until the note is saved. Your draft remains protected.');
          }
        }
        const data = await request('/api/notepad', {}, scope) as NotepadBootstrap;
        const note = data.notes.find(note => note.id === payload.noteId);
        const attachment = note?.attachments.find(item => item.id === payload.id);
        if (!attachment) throw Error('This attachment is no longer available to your account.');
        return attachment;
      }
      throw Error('Unsupported Notepad request.');
    };
    const receive = (event: MessageEvent) => {
      if (!alive || event.source !== frame.current?.contentWindow || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.channel !== CHANNEL || data.token !== token) return;
      if (data.type === 'ready') { ready = true; initializeFrame(); return; }
      // The frame survives account changes. Ignore messages queued by its prior
      // account even when they still carry this frame's valid bridge token.
      if (!bootstrap || data.scope !== `${bootstrap.hotelId}:${bootstrap.userId}`) return;
      const payload = data.payload || {};
      if (data.type === 'save' && bootstrap && typeof payload.id === 'string' && Number.isSafeInteger(payload.sequence)) sync.current?.queue(payload.id, payload.document as NotepadDocument | null, payload.sequence, payload.baseRevision === null || (Number.isSafeInteger(payload.baseRevision) && payload.baseRevision >= 0) ? payload.baseRevision : undefined, typeof payload.baseLegacyVersion === 'string' ? payload.baseLegacyVersion : null);
      if (data.type === 'order' && Array.isArray(payload.order) && payload.order.every((id: unknown) => typeof id === 'string')) sync.current?.queueOrder(payload.order);
      if (data.type === 'refresh') void load();
      if (data.type === 'flush') void sync.current?.flushAll();
      if (data.type === 'flushed') {
        if (!closingRequested || payload.requestId !== closingRequested.flushId) return;
        closingRequested.flushed = true;
        const coordinator = sync.current;
        void coordinator?.flushAll().then(finishRequestedClose);
      }
      if (data.type === 'openWorkOrder' && typeof payload.id === 'string') openWorkOrder.current?.(payload.id);
      if (data.type === 'request' && typeof data.requestId === 'string') {
        const generation = epoch;
        const uploading = data.action === 'upload';
        if (uploading) uploads.add(data.requestId);
        void mediaRequest(data.action, payload).then(result => {
          if (!alive || generation !== epoch) return;
          uploads.delete(data.requestId);
          post('result', { requestId: data.requestId, result });
          // The iframe must first install and queue the returned descriptor.
          // A fresh flush ID prevents an earlier acknowledgement closing early.
          if (uploading && closingRequested && !uploads.size) flushEditorForClose();
        }).catch(error => {
          if (!alive || generation !== epoch) return;
          uploads.delete(data.requestId);
          const message = error instanceof Error ? error.message : 'Notepad request failed.';
          post('result', { requestId: data.requestId, error: message });
          if (uploading) { closingRequested = null; setState(current => ({ ...current, error: true, message })); }
        });
      }
    };
    const wake = () => { if (!document.hidden) { void sync.current?.flushAll().then(load); post('palette', palette()); } };
    const onPageHide = () => { post('flush'); void sync.current?.flushAll(true); };
    const hostElement = host.current;
    const onCloseRequest = (event: Event) => {
      if (event.target !== hostElement) return;
      const request = (event as CustomEvent<NotepadCloseRequest>).detail;
      if (!request || typeof request.requestId !== 'string' || typeof request.onReady !== 'function' || !bootstrap || !sync.current) return;
      event.preventDefault();
      closingRequested = { ...request, flushed: false, flushId: '' };
      flushEditorForClose();
    };
    const localChange = (event: Event) => {
      const topics = (event as CustomEvent<{ topics?: string[] }>).detail?.topics;
      if (!document.hidden && (!topics?.length || topics.some(topic => ['notepad', 'general-notes', 'staff-notes'].includes(topic)))) void load();
    };
    window.addEventListener('cmpri-data-cache-invalidated', localChange);
    window.addEventListener('message', receive);
    window.addEventListener('focus', wake); window.addEventListener('online', wake);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', wake);
    hostElement?.addEventListener(NOTEPAD_CLOSE_REQUEST, onCloseRequest);
    const observer = new MutationObserver(() => post('palette', palette()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    if (host.current?.parentElement) observer.observe(host.current.parentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-cmpri-modal-theme'] });
    const { data: authListener } = client.auth.onAuthStateChange((event, session) => {
      const userId = session?.user.id || null;
      if (event === 'SIGNED_OUT') { resetSession(null, false, 'Sign in to open Notepad.'); return; }
      if (!userId) return;
      if (userId !== authorizedUserId) { resetSession(userId, true); return; }
      if (!bootstrap && !loading) queueMicrotask(() => { if (alive) void load(); });
    });
    setSource(`/notepad/editor.html?bridge=${encodeURIComponent(token)}`);
    void load();
    return () => {
      alive = false; epoch++; controllers.forEach(controller => controller.abort()); sync.current?.stop(); sync.current = null;
      if (subscription) void client.removeChannel(subscription);
      authListener.subscription.unsubscribe(); observer.disconnect();
      window.removeEventListener('cmpri-data-cache-invalidated', localChange);
      window.removeEventListener('message', receive); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', wake); hostElement?.removeEventListener(NOTEPAD_CLOSE_REQUEST, onCloseRequest);
      send.current = () => {};
    };
  }, []);

  function downloadDrafts() {
    if (!sync.current) return;
    const url = URL.createObjectURL(new Blob([sync.current.drafts()], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'Notepad-unsaved-drafts.json'; link.click(); URL.revokeObjectURL(url);
  }
  async function reloadConflicts() {
    if (!window.confirm('Reload the saved notes and discard the conflicting local edits? Download your draft first if you need to keep it.')) return;
    sync.current?.discardConflicts(); send.current('discard', { ids: state.conflictIds }); await reload.current();
  }
  return <div ref={host} className="cmpri-notepad-host" data-compact={compact || undefined}>
    {notice && <div className="cmpri-notepad-loading" role="status">{notice}<button type="button" onClick={() => void reload.current()}>Retry</button></div>}
    {source && <iframe ref={frame} src={source} title="Notepad" className="cmpri-notepad-frame" allow="local-fonts" onLoad={() => send.current('hello')} />}
    {state.error && <div className="cmpri-notepad-sync-error" role="alert"><span>{state.message}</span><button type="button" onClick={() => void sync.current?.flushAll().then(() => reload.current())}>Retry</button><button type="button" onClick={downloadDrafts}>Download draft</button>{state.conflictIds.length > 0 && <button type="button" onClick={() => void reloadConflicts()}>Reload saved notes</button>}</div>}
  </div>;
}
