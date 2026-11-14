"use client";
import { DeviceDataCache } from './core';
import { IndexedDataStore, MemoryDataStore } from './store';
import { dataCachePolicy, mutationTopics } from './policy';

type Session = { user: { id: string; role: string; secondary_roles?: string[] }; hotelId: string; capabilities: string[] };
const sessionChanged = () => new Response(JSON.stringify({ error: 'The device session changed. Reload to continue.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
type CacheWindow = Window & typeof globalThis & { __cmpriDeviceData?: BrowserDataCache; __cmpriNativeFetch?: typeof fetch };
type CachedFetch = typeof fetch & { cmpriCached?: boolean; cmpriCacheDocument?: Document };
function activeDocument(document?: Document) { try { return !!document && document.defaultView?.document === document; } catch { return false; } }
function owner(view: Window = window): CacheWindow {
  let current: Window = view;
  try { while (current.parent !== current && current.parent.location.origin === view.location.origin) current = current.parent; } catch {}
  return current as CacheWindow;
}
function permissionKey(session: Session) {
  const value = JSON.stringify([session.user.role, [...(session.user.secondary_roles || [])].sort(), [...session.capabilities].sort()]);
  let hash = 2166136261; for (const c of value) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return session.user.id + ':' + session.hotelId + ':' + (hash >>> 0).toString(16);
}
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    // Consume the underlying result even if the caller was already aborted.
    // Shared work can finish later and must never become an unhandled rejection.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
class BrowserDataCache {
  private native: typeof fetch;
  private lifetime: AbortController;
  get signal() { return this.lifetime.signal; }
  readonly creatorDocument = window.document;
  private headerClick?: (event: MouseEvent) => void;
  private releaseOwner?: () => void;
  private cache: DeviceDataCache;
  private scope?: string;
  private identity?: Session;
  private authorization = '';
  private validated = 0;
  private generation = 0;
  private authRead?: { authorization: string; promise: Promise<Response> };
  private revisionRead?: Promise<void>;
  private channel?: BroadcastChannel;
  private host: CacheWindow;
  constructor(host: CacheWindow) {
    this.host = host;
    this.lifetime = new host.AbortController();
    this.native = host.__cmpriNativeFetch ??= host.fetch.bind(host);
    let store; try { store = host.indexedDB ? new IndexedDataStore(host.indexedDB) : new MemoryDataStore(); } catch { store = new MemoryDataStore(); }
    this.cache = new DeviceDataCache(store);
    if (host.BroadcastChannel) {
      this.channel = new host.BroadcastChannel('cmpri-device-data-v1');
      this.channel.onmessage = event => {
        if (event.data?.type === 'clear') void this.clear(false);
        else if (event.data?.type === 'invalidate' && event.data.scope === this.scope) {
          const topics = Array.isArray(event.data.topics) ? event.data.topics.filter((t: unknown) => typeof t === 'string') : undefined;
          void this.cache.invalidate(this.scope, topics).then(() => this.notify(topics));
        }
      };
    }
    this.headerClick = event => {
      const control = (event.target as Element | null)?.closest?.('button,[role=button]');
      if (control && (/^refresh(?:\s|$)/i.test(control.textContent?.trim() || '') || control.hasAttribute('data-cmpri-force-refresh'))) void this.invalidate();
    };
    host.document.addEventListener('click', this.headerClick, true);
    this.releaseOwner = () => {
      if (host.__cmpriDeviceData === this) {
        delete host.__cmpriDeviceData;
        if ((host.fetch as CachedFetch).cmpriCacheDocument === this.creatorDocument) host.fetch = host.__cmpriNativeFetch!;
      }
      this.dispose();
    };
    this.creatorDocument.defaultView?.addEventListener('pagehide', this.releaseOwner, { once: true });
  }
  isActive() { return activeDocument(this.creatorDocument); }
  dispose() {
    this.generation++;
    this.lifetime.abort(new this.host.DOMException('The cache owner document closed.', 'AbortError'));
    this.channel?.close();
    if (this.headerClick) this.host.document.removeEventListener('click', this.headerClick, true);
    if (this.releaseOwner) this.creatorDocument.defaultView?.removeEventListener('pagehide', this.releaseOwner);
  }
  private notify(topics?: readonly string[]) {
    this.host.dispatchEvent(new this.host.CustomEvent('cmpri-data-cache-invalidated', { detail: { topics } }));
  }
  async clear(broadcast = true) {
    this.generation++; this.scope = undefined; this.identity = undefined; this.authorization = ''; this.validated = 0; this.authRead = undefined; this.revisionRead = undefined;
    try { this.host.localStorage.removeItem('cmpri:data-cache:scope'); } catch {}
    if (broadcast) this.channel?.postMessage({ type: 'clear' });
    await this.cache.clear(); this.notify(['session']);
  }
  async invalidate(topics?: readonly string[], broadcast = true, emit = true) {
    if (topics?.length === 0) return;
    const scope = this.scope;
    await this.cache.invalidate(scope, topics);
    if (broadcast) this.channel?.postMessage({ type: 'invalidate', scope, topics });
    if (emit) this.notify(topics);
  }
  async revision(topic: string, value?: number, emit = true) {
    if (!this.scope) return;
    if (typeof value === 'number' && Number.isFinite(value)) {
      const changed = await this.cache.reconcile(this.scope, { [topic]: value });
      if (changed.length && emit) this.notify(changed);
    } else await this.invalidate([topic], true, emit);
    if (topic === 'session') { this.validated = 0; await this.invalidate(); }
  }
  reconcile() {
    if (!this.scope || !this.identity || !this.authorization) return Promise.resolve();
    if (this.revisionRead) return this.revisionRead;
    const scope = this.scope, generation = this.generation, identity = this.identity;
    this.revisionRead = (async () => {
      try {
        const result = await this.native(new Request(new URL('/api/resource-revisions', this.host.location.origin), { headers: { Authorization: this.authorization }, cache: 'no-store', signal: this.signal }));
        if (generation !== this.generation) return;
        if (result.status === 401 || result.status === 403) { await this.clear(); return; }
        const payload = await result.json();
        if (!result.ok || payload.userId !== identity.user.id || payload.hotelId !== identity.hotelId || !payload.versions) throw Error('Revision check unavailable');
        const vector = Object.fromEntries(Object.entries(payload.versions).filter(([, n]) => typeof n === 'number' && Number.isFinite(n))) as Record<string, number>;
        const changed = await this.cache.reconcile(scope, vector);
        if (changed.includes('session')) this.validated = 0;
        if (changed.length) this.notify(changed);
      } catch {
        // Never trust durable records across a reconnect when freshness cannot be verified.
        if (generation === this.generation) await this.cache.invalidate(scope);
      }
    })().finally(() => { if (generation === this.generation) this.revisionRead = undefined; });
    return this.revisionRead;
  }
  private async session(request: Request): Promise<Response> {
    const authorization = request.headers.get('authorization') || '';
    if (this.authRead?.authorization === authorization) return (await this.authRead.promise).clone();
    const generation = this.generation;
    const promise = (async () => {
      const response = await this.native(request);
      if (generation !== this.generation) return sessionChanged();
      if (response.status === 401 || response.status === 403) { await this.clear(); return response; }
      if (response.ok) {
        const session: Session = await response.clone().json();
        if (session.user?.id && session.hotelId && Array.isArray(session.capabilities)) {
          const scope = permissionKey(session);
          let previous; try { previous = this.host.localStorage.getItem('cmpri:data-cache:scope'); } catch {}
          if ((this.scope && this.scope !== scope) || (previous && previous !== scope)) { this.generation++; await this.cache.clear(); }
          const changed = this.scope !== scope;
          this.scope = scope; this.identity = session; this.authorization = authorization; this.validated = Date.now();
          try { this.host.localStorage.setItem('cmpri:data-cache:scope', scope); } catch {}
          if (changed) void this.reconcile();
        }
      }
      return response;
    })().finally(() => { if (this.authRead?.promise === promise) this.authRead = undefined; });
    this.authRead = { authorization, promise }; return (await promise).clone();
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== this.host.location.origin || !url.pathname.startsWith('/api/')) return this.native(request);
    if (url.pathname === '/api/session' && request.method === 'GET') return withAbort(this.session(new Request(request, { signal: this.signal })), request.signal);
    if (request.method !== 'GET') {
      const response = await this.native(request);
      if (response.status === 401 || response.status === 403) await this.clear();
      else if (response.ok && ['POST','PUT','PATCH','DELETE'].includes(request.method)) await this.invalidate(mutationTopics(url.pathname));
      return response;
    }
    const policy = dataCachePolicy(url.pathname, url.searchParams), authorization = request.headers.get('authorization');
    if (!policy || !authorization || [...url.searchParams.keys()].some(key => /^(access_token|refresh_token|token|password|secret|signature|api_key)$/i.test(key))) {
      const response = await this.native(request);
      if (response.status === 401 || response.status === 403) await this.clear();
      return response;
    }
    if (!this.scope || authorization !== this.authorization || Date.now() - this.validated >= 60_000) {
      const result = await this.session(new Request(new URL('/api/session', this.host.location.origin), { headers: { Authorization: authorization }, cache: 'no-store' }));
      if (!result.ok) return result;
    }
    await this.revisionRead;
    if (!this.scope) return this.native(request);
    const scope = this.scope, generation = this.generation;
    url.searchParams.sort();
    const key = url.href + '\n' + (request.headers.get('accept') || 'application/json');
    const force = request.cache === 'reload' || request.headers.get('X-CMPRI-Refresh') === '1';
    const scopedPolicy = { ...policy, topics: [...policy.topics, 'session'] };
    const result = await withAbort(this.cache.read(scope, key, scopedPolicy, async () => {
      const response = await this.native(new Request(request, { signal: this.signal }));
      if (response.status === 401 || response.status === 403) await this.clear();
      return response;
    }, force), request.signal);
    if (generation !== this.generation || scope !== this.scope) return sessionChanged();
    return result;
  }
}
export function installDeviceDataCache() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function' || typeof Request === 'undefined') return;
  const host = owner();
  host.__cmpriNativeFetch ??= host.fetch.bind(host);
  if (host.__cmpriDeviceData && typeof host.__cmpriDeviceData.isActive === 'function' && !host.__cmpriDeviceData.isActive()) {
    host.__cmpriDeviceData.dispose();
    delete host.__cmpriDeviceData;
  }
  host.__cmpriDeviceData ??= new BrowserDataCache(host);
  const apply = (view: CacheWindow) => {
    const current = view.fetch as CachedFetch;
    if (current.cmpriCached && (!current.cmpriCacheDocument || activeDocument(current.cmpriCacheDocument))) return;
    const wrapped: CachedFetch = (input, init) => {
      const source = typeof input === 'string' ? new URL(input, view.location.href) : input;
      const request = new Request(source, init);
      // A surviving sibling may call after the creator iframe was removed.
      if (!host.__cmpriDeviceData) installDeviceDataCache();
      const manager = host.__cmpriDeviceData!;
      const signal = manager.signal ? AbortSignal.any([request.signal, manager.signal]) : request.signal;
      return withAbort(manager.fetch(new Request(request, { signal })), signal);
    };
    wrapped.cmpriCached = true;
    wrapped.cmpriCacheDocument = window.document;
    view.fetch = wrapped;
  };
  apply(host); apply(window as CacheWindow);
}
export function invalidateCachedResources(topics?: readonly string[], revision?: number, emit = true) {
  if (typeof window === 'undefined') return Promise.resolve();
  const manager = owner().__cmpriDeviceData;
  return revision !== undefined && topics?.length === 1 ? manager?.revision(topics[0], revision, emit) || Promise.resolve() : manager?.invalidate(topics, true, emit) || Promise.resolve();
}
export function reconcileDeviceDataCache() { return typeof window === 'undefined' ? Promise.resolve() : owner().__cmpriDeviceData?.reconcile() || Promise.resolve(); }
export function clearDeviceDataCache() { if (typeof window === 'undefined') return Promise.resolve(); installDeviceDataCache(); return owner().__cmpriDeviceData!.clear(); }
