export type DataEntry = {
  key: string; scope: string; topics: string[]; body: string; status: number;
  contentType: string; savedAt: number; expiresAt: number; bytes: number;
};
export interface DataStore {
  get(key: string): Promise<DataEntry | undefined>;
  put(entry: DataEntry): Promise<void>;
  remove(scope?: string, topics?: readonly string[]): Promise<void>;
  versions(scope: string): Promise<Record<string, number>>;
  saveVersions(scope: string, versions: Record<string, number>): Promise<void>;
}
const MAX_BYTES = 32 * 1024 * 1024, MAX_ENTRIES = 300;
export class MemoryDataStore implements DataStore {
  entries = new Map<string, DataEntry>();
  vectors = new Map<string, Record<string, number>>();
  async get(key: string) { return this.entries.get(key); }
  async put(entry: DataEntry) {
    this.entries.delete(entry.key); this.entries.set(entry.key, entry);
    let size = [...this.entries.values()].reduce((n, e) => n + e.bytes, 0);
    while (this.entries.size > MAX_ENTRIES || size > MAX_BYTES) {
      const oldest = this.entries.values().next().value;
      if (!oldest) break; this.entries.delete(oldest.key); size -= oldest.bytes;
    }
  }
  async remove(scope?: string, topics?: readonly string[]) {
    for (const [key, entry] of this.entries) if ((!scope || entry.scope === scope) && (!topics || entry.topics.some(t => topics.includes(t)))) this.entries.delete(key);
    if (!scope) this.vectors.clear();
  }
  async versions(scope: string) { return { ...this.vectors.get(scope) }; }
  async saveVersions(scope: string, versions: Record<string, number>) { this.vectors.set(scope, { ...versions }); }
}
const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
});
const complete = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error);
});
export class IndexedDataStore implements DataStore {
  private connection?: Promise<IDBDatabase>;
  private factory: IDBFactory;
  constructor(factory: IDBFactory) { this.factory = factory; }
  private open() {
    return this.connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.factory.open('cmpri-device-data-v1', 1);
      req.onupgradeneeded = () => {
        const entries = req.result.createObjectStore('entries', { keyPath: 'key' });
        entries.createIndex('savedAt', 'savedAt'); req.result.createObjectStore('metadata');
      };
      req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); this.connection = undefined; }; resolve(req.result); };
      req.onerror = () => { this.connection = undefined; reject(req.error); };
    });
  }
  async get(key: string) { const db = await this.open(); return request<DataEntry | undefined>(db.transaction('entries').objectStore('entries').get(key)); }
  async put(entry: DataEntry) {
    const db = await this.open(), tx = db.transaction(['entries','metadata'], 'readwrite'), done = complete(tx);
    const entries = tx.objectStore('entries'), meta = tx.objectStore('metadata');
    const [old, stored] = await Promise.all([request<DataEntry | undefined>(entries.get(entry.key)), request<{ count: number; bytes: number } | undefined>(meta.get('usage'))]);
    const usage = stored || { count: 0, bytes: 0 };
    usage.count += old ? 0 : 1; usage.bytes += entry.bytes - (old?.bytes || 0);
    entries.put(entry);
    if (usage.bytes > MAX_BYTES || usage.count > MAX_ENTRIES) {
      await new Promise<void>((resolve, reject) => {
        const cursor = entries.index('savedAt').openCursor(); cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item || (usage.bytes <= MAX_BYTES && usage.count <= MAX_ENTRIES)) { resolve(); return; }
          usage.bytes -= (item.value as DataEntry).bytes; usage.count--; item.delete(); item.continue();
        };
      });
    }
    meta.put(usage, 'usage'); await done;
  }
  async remove(scope?: string, topics?: readonly string[]) {
    const db = await this.open(), tx = db.transaction(['entries','metadata'], 'readwrite'), done = complete(tx);
    const entries = tx.objectStore('entries'), meta = tx.objectStore('metadata');
    if (!scope && !topics) { entries.clear(); meta.clear(); await done; return; }
    const usage = await request<{ count: number; bytes: number } | undefined>(meta.get('usage')) || { count: 0, bytes: 0 };
    await new Promise<void>((resolve, reject) => {
      const cursor = entries.openCursor(); cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const item = cursor.result; if (!item) { resolve(); return; }
        const entry = item.value as DataEntry;
        if ((!scope || entry.scope === scope) && (!topics || entry.topics.some(t => topics.includes(t)))) { usage.count--; usage.bytes -= entry.bytes; item.delete(); }
        item.continue();
      };
    });
    meta.put(usage, 'usage'); await done;
  }
  async versions(scope: string) {
    const db = await this.open(); return await request<Record<string, number> | undefined>(db.transaction('metadata').objectStore('metadata').get('versions:' + scope)) || {};
  }
  async saveVersions(scope: string, versions: Record<string, number>) {
    const db = await this.open(), tx = db.transaction('metadata', 'readwrite'), done = complete(tx);
    tx.objectStore('metadata').put(versions, 'versions:' + scope); await done;
  }
}
