import { MemoryDataStore, type DataEntry, type DataStore } from './store';
import type { CachePolicy } from './policy';
export class DeviceDataCache {
  private memory = new MemoryDataStore();
  private pending = new Map<string, Promise<Response>>();
  private epoch = 0;
  private invalidations = new Map<string, number>();
  private barrier = Promise.resolve();
  private vectors = new Map<string, Record<string, number>>();
  private disk: DataStore;
  private now: () => number;
  constructor(disk: DataStore, now = Date.now) { this.disk = disk; this.now = now; }
  private stamp(scope: string, topics: readonly string[]) { return [this.epoch, ...topics.map(t => this.invalidations.get(scope + ':' + t) || 0)].join(':'); }
  private response(entry: DataEntry) { return new Response(entry.body, { status: entry.status, headers: { 'Content-Type': entry.contentType, 'Cache-Control': 'private, no-store', 'X-CMPRI-Data-Cache': 'hit' } }); }
  async read(scope: string, url: string, policy: CachePolicy, network: () => Promise<Response>, force = false): Promise<Response> {
    const key = scope + '\n' + url, stamp = this.stamp(scope, policy.topics);
    await this.barrier;
    const cached = await this.memory.get(key) || (policy.durable ? await this.disk.get(key).catch(() => undefined) : undefined);
    if (!force && cached && cached.expiresAt > this.now() && this.stamp(scope, policy.topics) === stamp) { await this.memory.put(cached); return this.response(cached); }
    const jobKey = key + ':' + stamp;
    let pending = this.pending.get(jobKey);
    if (!pending) {
      pending = (async () => {
        const result = await network();
        if (result.status === 200 && (result.headers.get('content-type') || '').includes('application/json')) {
          const body = await result.clone().text(), bytes = body.length * 2;
          const privateLink = /\/storage\/v1\/object\/sign\/|[?&](?:token|signature|X-Amz-Signature)=/i.test(body);
          if (bytes <= 2 * 1024 * 1024 && !privateLink && !/"(?:access_token|refresh_token|password|secret|api[_-]?key|signed_?url)"\s*:/i.test(body) && this.stamp(scope, policy.topics) === stamp) {
            const savedAt = this.now(), entry = { key, scope, topics: policy.topics, body, status: result.status, contentType: result.headers.get('content-type')!, savedAt, expiresAt: savedAt + policy.ttl, bytes };
            await this.memory.put(entry);
            if (policy.durable) { await this.disk.put(entry).catch(() => {}); if (this.stamp(scope, policy.topics) !== stamp) await this.disk.remove(scope, policy.topics).catch(() => {}); }
          }
        }
        return result;
      })().finally(() => this.pending.delete(jobKey));
      this.pending.set(jobKey, pending);
    }
    return (await pending).clone();
  }
  invalidate(scope?: string, topics?: readonly string[]) {
    if (topics?.length === 0) return this.barrier;
    if (!topics || !scope) this.epoch++;
    else for (const topic of topics) { const key = scope + ':' + topic; this.invalidations.set(key, (this.invalidations.get(key) || 0) + 1); }
    this.barrier = this.barrier.then(async () => {
      await this.memory.remove(scope, topics); await this.disk.remove(scope, topics).catch(() => {});
    });
    return this.barrier;
  }
  async reconcile(scope: string, vector: Record<string, number>) {
    const epoch = this.epoch;
    const stored: Record<string, number> = this.vectors.get(scope) || await this.disk.versions(scope).catch(() => ({} as Record<string, number>));
    if (epoch !== this.epoch) return [];
    const previous = this.vectors.get(scope) || stored;
    const current = { ...previous }, changed = Object.keys(vector).filter(t => vector[t] > (previous[t] || 0));
    for (const [topic, version] of Object.entries(vector)) current[topic] = Math.max(previous[topic] || 0, version);
    this.vectors.set(scope, current);
    if (changed.length) void this.invalidate(scope, changed);
    this.barrier = this.barrier.then(async () => { if (epoch === this.epoch) await this.disk.saveVersions(scope, current).catch(() => {}); });
    await this.barrier;
    return changed;
  }
  clear() { this.vectors.clear(); return this.invalidate(); }
}
