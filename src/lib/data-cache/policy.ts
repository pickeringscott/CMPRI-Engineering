export type CachePolicy = { topics: string[]; ttl: number; durable: boolean };
const second = 1000;
/** App-local JSON only. Authentication, secrets, signed URLs and private files stay on the network. */
export function dataCachePolicy(path: string, search?: URLSearchParams): CachePolicy | null {
  // Checklist permissions, revisions and attached-source bytes are authoritative reads.
  if (/^\/api\/work-orders\/[^/]+\/troubleshooting(?:\/|$)/.test(path)
    || (path === '/api/maintenance-reference' && search?.get('source') === 'asset-upload')) return null;
  // Explicit Drive acquisition must always reach Drive and never persist raw CSVs on the device.
  if (path === "/api/room-operations/guest-reports/drive") return null;
  // Opening a ticket records engineering/technician views; those reads must reach the server.
  if (/^\/api\/work-orders\/[0-9a-f-]{36}$/i.test(path)) return null;
  if (!path.startsWith('/api/') || /\/(session|resource-revisions|auth|integrations|assistant|chat|ai|oauth|settings|config|account|permissions)(\/|$)/.test(path)
    || /\/(uploads?|attachments|download|export|extract|scan|credentials|phone-notifications|ai-connection)(\/|$)/.test(path)) return null;
  if (/^\/api\/(profile|users|management\/users)(\/|$)/.test(path) || /employment|hours-tracker/.test(path)) return null;
  if (/staff-notes/.test(path)) return { topics: ['notes','inbox'], ttl: 15*second, durable: false };
  if (/notifications|mentions/.test(path)) return { topics: ['inbox','orders'], ttl: 10*second, durable: false };
  if (/pool/.test(path)) return { topics: ['pool'], ttl: 15*second, durable: true };
  if (/work-orders|purchas|warrant|followup|enseo/.test(path)) return { topics: ['orders','reference'], ttl: 30*second, durable: true };
  if (/rooms|room-operations|room-ranker|room-ranking|ticket-room-ranker/.test(path)) return { topics: ['rooms','orders','reference'], ttl: 30*second, durable: true };
  if (/assets|maintenance-reference|catalog|parts|inventory|vendors|supplier|preventive-maintenance|pm-|guides/.test(path)) return { topics: ['reference','rooms'], ttl: 5*60*second, durable: true };
  if (/feedback/.test(path)) return { topics: ['feedback'], ttl: 30*second, durable: false };
  return { topics: ['reference','orders','rooms'], ttl: 30*second, durable: true };
}
export function mutationTopics(path: string): string[] | undefined {
  if (/\/(extract|preview|parse|export|suggestions)(\/|$)/.test(path) || /\/staff-notes\/uploads$/.test(path)) return [];
  if (/^\/api\/profile\/header-layout$/.test(path)) return [];
  if (/^\/api\/(profile|users|session)(\/|$)/.test(path)) return undefined;
  if (/staff-notes/.test(path)) return ['notes','inbox'];
  if (/notifications|mentions/.test(path)) return ['inbox'];
  if (/pool/.test(path)) return ['pool'];
  if (/work-orders|purchas|warrant|followup|enseo/.test(path)) return ['orders','rooms','reference'];
  return dataCachePolicy(path)?.topics;
}
