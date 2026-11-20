export type FootballBettingLine = {
  status: 'available' | 'stale' | 'unavailable';
  line: string | null;
  provider: string | null;
  retrievedAt: string | null;
  sourceUpdatedAt: string | null;
  event: { id: string; date: string; state: 'pre' | 'in'; away: string; home: string } | null;
  sourceUrl: string;
  error: string | null;
};

const IOWA = '2294', ILLINOIS = '356';
const MAX_BYTES = 2 * 1024 * 1024, TTL = 60_000, MAX_STALE = 5 * 60_000;
const SCOREBOARD = 'https://www.espn.com/college-football/scoreboard';
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, limit = 100): string | null => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= limit ? value.trim() : null;
const numericId = (value: unknown): string | null => typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null;

function unavailable(error: string): FootballBettingLine {
  return { status: 'unavailable', line: null, provider: null, retrievedAt: null, sourceUpdatedAt: null, event: null, sourceUrl: SCOREBOARD, error };
}

function season(now: number) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric' }).formatToParts(now);
  const year = Number(parts.find(part => part.type === 'year')?.value);
  return Number(parts.find(part => part.type === 'month')?.value) < 3 ? year - 1 : year;
}

function matchup(payload: unknown, now: number) {
  const root = object(payload);
  if (!root || !Array.isArray(root.events)) throw new Error('The football schedule could not be verified.');
  const candidates = root.events.flatMap(raw => {
    const event = object(raw), id = numericId(event?.id), date = text(event?.date, 40);
    const competition = list(event?.competitions).map(object).find(value => value && list(value.competitors).length === 2);
    const competitionId = numericId(competition?.id);
    const competitors = list(competition?.competitors).map(object);
    const ids = competitors.map(value => numericId(object(value?.team)?.id));
    const state = text(object(object(competition?.status)?.type)?.state ?? object(object(event?.status)?.type)?.state);
    const starts = date ? Date.parse(date) : NaN;
    if (!id || !competitionId || !date || !Number.isFinite(starts) || !ids.includes(IOWA) || !ids.includes(ILLINOIS)
      || !['pre', 'in'].includes(state || '') || starts < now - (state === 'in' ? 36 : 6) * 3_600_000
      || starts > now + 370 * 86_400_000) return [];
    const away = competitors.find(value => value?.homeAway === 'away');
    const home = competitors.find(value => value?.homeAway === 'home');
    const name = (value: ObjectValue | null | undefined) => text(object(value?.team)?.shortDisplayName) || text(object(value?.team)?.displayName);
    const awayName = name(away), homeName = name(home);
    if (!awayName || !homeName) return [];
    const abbreviations = competitors.map(value => text(object(value?.team)?.abbreviation, 20)).filter((value): value is string => Boolean(value));
    return [{ id, competitionId, date: new Date(starts).toISOString(), state: state as 'pre' | 'in', away: awayName, home: homeName, starts, abbreviations }];
  });
  return candidates.sort((a, b) => (a.state === 'in' ? 0 : 1) - (b.state === 'in' ? 0 : 1) || a.starts - b.starts)[0] || null;
}

function currentLine(payload: unknown, abbreviations: string[], now: number) {
  const record = object(payload);
  // The collection's details is the current headline. Opening/closing market
  // fields are deliberately not fallbacks for a live/current betting line.
  const candidate = text(record?.details, 80);
  if (!candidate) return null;
  const line = candidate.replace(/\s+/g, ' ');
  const spread = line.match(/^(.+?)\s+([+-]\d{1,3}(?:\.\d{1,2})?|PK|EVEN|PICK(?:'EM)?)$/i);
  const explicitEven = /^(PK|EVEN|PICK(?:'EM)?)$/i.test(line);
  if (!explicitEven && (!spread || !abbreviations.some(abbreviation => spread[1].toUpperCase() === abbreviation.toUpperCase()))) return null;
  const provider = text(object(record?.provider)?.name, 80);
  if (!provider) return null;
  const updated = text(record?.lastUpdated ?? record?.lastUpdatedDate ?? record?.updatedAt, 50);
  const parsed = updated ? Date.parse(updated) : NaN;
  return { line, provider, sourceUpdatedAt: Number.isFinite(parsed) && parsed <= now + 300_000 ? new Date(parsed).toISOString() : null };
}

async function json(fetcher: typeof fetch, url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetcher(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
    headers: { Accept: 'application/json', 'User-Agent': 'CMPRI-Football-Betting-Line/1.0' } });
  if (!response.ok || !/^application\/(?:[a-z0-9.+-]+\+)?json\b/i.test(response.headers.get('content-type') || '')
    || Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw new Error('The published betting line could not be verified.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('The betting feed exceeded its read limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  signal.throwIfAborted();
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

export function createFootballBettingFeed(options: { fetcher?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
  const fetcher = options.fetcher ?? fetch, clock = options.now ?? Date.now;
  let cached: { at: number; value: FootballBettingLine } | null = null;
  let priorGood: FootballBettingLine | null = null;
  let pending: Promise<FootballBettingLine> | null = null;
  async function refresh(): Promise<FootballBettingLine> {
    const now = clock(), signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
    try {
      const schedule = await json(fetcher, 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/' + IOWA + '/schedule?season=' + season(now), signal);
      const game = matchup(schedule, now);
      if (!game) {
        priorGood = null;
        return unavailable('No current or upcoming Iowa–Illinois matchup with a verified betting line.');
      }
      const base = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/' + game.id + '/competitions/' + game.competitionId + '/odds';
      const odds = object(await json(fetcher, base + '?lang=en&region=us', signal));
      if (!odds || !Array.isArray(odds.items)) throw new Error('The betting provider did not publish a verified odds collection.');
      let market = odds.items.map(value => currentLine(value, game.abbreviations, clock())).find(Boolean);
      if (!market) {
        // Some ESPN collections advertise provider records by reference. Only
        // numeric provider IDs under this exact advertised event are accepted.
        const refs = odds.items.map(value => text(object(value)?.$ref, 500)).filter((value): value is string => Boolean(value)).slice(0, 2);
        for (const ref of refs) {
          const url = new URL(ref);
          const prefix = new URL(base).pathname + '/';
          if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'sports.core.api.espn.com'
            || !url.pathname.startsWith(prefix) || !/^\d{1,20}$/.test(url.pathname.slice(prefix.length))) continue;
          market = currentLine(await json(fetcher, 'https://sports.core.api.espn.com' + url.pathname + '?lang=en&region=us', signal), game.abbreviations, clock());
          if (market) break;
        }
      }
      if (!market) {
        priorGood = null;
        return unavailable('The provider has not published a current Iowa–Illinois point spread.');
      }
      const value: FootballBettingLine = { status: 'available', ...market, retrievedAt: new Date(clock()).toISOString(),
        event: { id: game.id, date: game.date, state: game.state, away: game.away, home: game.home },
        sourceUrl: 'https://www.espn.com/college-football/game/_/gameId/' + game.id, error: null };
      priorGood = value;
      return value;
    } catch {
      const age = priorGood?.retrievedAt ? clock() - Date.parse(priorGood.retrievedAt) : Infinity;
      if (priorGood && age >= 0 && age <= MAX_STALE) return { ...priorGood, status: 'stale', error: 'The latest betting line could not be verified; this is the last published value.' };
      return unavailable('The current Iowa–Illinois betting line could not be verified.');
    }
  }
  return async function read(signal?: AbortSignal): Promise<FootballBettingLine> {
    signal?.throwIfAborted();
    const age = cached ? clock() - cached.at : Infinity;
    const retainedAge = cached?.value.retrievedAt ? clock() - Date.parse(cached.value.retrievedAt) : Infinity;
    if (cached && age >= 0 && age < TTL && (cached.value.status !== 'stale' || retainedAge <= MAX_STALE)) return cached.value;
    if (!pending) pending = refresh().then(value => { cached = { at: clock(), value }; return value; }).finally(() => { pending = null; });
    const value = await pending;
    signal?.throwIfAborted();
    return value;
  };
}

export const footballBettingLine = createFootballBettingFeed();
