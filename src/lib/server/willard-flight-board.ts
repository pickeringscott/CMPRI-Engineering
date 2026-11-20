/** Extract published flight facts from Avionio's fixed public CMI board.
 * This is an inert, bounded structural reader, not a browser or a flight API.
 * Source layout verified 2026-11-20; no provider markup/scripts are returned.
 */
export type WillardBoardKind = 'arrivals' | 'departures';
export type WillardFlight = {
  id: string; flight: string; airline: string; location: string; iata: string;
  date: string; time: string; status: string;
};
export type WillardBoard = { providerDate: string; flights: WillardFlight[]; explicitEmpty: boolean };

type HtmlNode = { tag: string; attrs: Record<string, string>; children: (HtmlNode | string)[] };
const MAX_BYTES = 1024 * 1024, MAX_NODES = 12000, MAX_DEPTH = 64, MAX_FLIGHTS = 200;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const centralCalendar = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
const invalid = () => new Error('Avionio flight board structure is unavailable or has changed.');

function decode(value: string): string {
  const names: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]*);/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const number = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      if (!Number.isInteger(number) || number <= 0 || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff) throw invalid();
      return String.fromCodePoint(number);
    }
    if (!(name in names)) throw invalid();
    return names[name];
  });
}

function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let offset = 0, count = 0;
  while (offset < value.length) {
    while (/\s/.test(value[offset] || '') && offset < value.length) offset += 1;
    if (offset === value.length) break;
    const key = /^[^\s"'<>/=]+/.exec(value.slice(offset))?.[0].toLowerCase();
    if (!key || ++count > 100 || Object.hasOwn(result, key)) throw invalid();
    offset += key.length;
    while (/\s/.test(value[offset] || '') && offset < value.length) offset += 1;
    let raw = '';
    if (value[offset] === '=') {
      offset += 1;
      while (/\s/.test(value[offset] || '') && offset < value.length) offset += 1;
      const quote = value[offset];
      if (quote === '"' || quote === "'") {
        const end = value.indexOf(quote, offset + 1);
        if (end < 0) throw invalid();
        raw = value.slice(offset + 1, end); offset = end + 1;
      } else {
        const match = /^[^\s"'<>`=]+/.exec(value.slice(offset));
        if (!match) throw invalid();
        raw = match[0]; offset += raw.length;
      }
    }
    result[key] = decode(raw);
  }
  return result;
}

function tree(html: string): HtmlNode {
  const root: HtmlNode = { tag: '#document', attrs: {}, children: [] }, stack = [root];
  let offset = 0, count = 0;
  while (offset < html.length) {
    const open = html.indexOf('<', offset);
    if (open < 0) { stack[stack.length - 1].children.push(html.slice(offset)); break; }
    if (open > offset) stack[stack.length - 1].children.push(html.slice(offset, open));
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4); if (end < 0) throw invalid();
      offset = end + 3; continue;
    }
    let end = open + 1, quote = '';
    for (; end < html.length; end += 1) {
      const character = html[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === html.length) throw invalid();
    const token = html.slice(open + 1, end).trim(); offset = end + 1;
    if (/^!doctype\s+html$/i.test(token)) continue;
    const closing = token.startsWith('/'), match = /^(\/?)([a-z][\w:-]*)/i.exec(token);
    if (!match || ++count > MAX_NODES) throw invalid();
    const tag = match[2].toLowerCase();
    if (closing) {
      if (token.slice(match[0].length).trim() || stack.length === 1 || stack[stack.length - 1].tag !== tag) throw invalid();
      stack.pop(); continue;
    }
    const selfClosing = token.endsWith('/');
    const node: HtmlNode = { tag, attrs: attributes(token.slice(match[0].length, selfClosing ? -1 : undefined)), children: [] };
    stack[stack.length - 1].children.push(node);
    // Raw script/style bodies never become field text or execute.
    if (tag === 'script' || tag === 'style') {
      const close = new RegExp('</' + tag + '\\s*>', 'ig'); close.lastIndex = offset;
      const found = close.exec(html); if (!found) throw invalid();
      offset = close.lastIndex; continue;
    }
    if (!selfClosing && !VOID.has(tag)) { stack.push(node); if (stack.length > MAX_DEPTH) throw invalid(); }
  }
  if (stack.length !== 1) throw invalid();
  return root;
}

function hasClass(node: HtmlNode, name: string): boolean { return (node.attrs.class || '').split(/\s+/).includes(name); }
function find(root: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode[] {
  const result: HtmlNode[] = [];
  for (const child of root.children) if (typeof child !== 'string') {
    if (predicate(child)) result.push(child);
    result.push(...find(child, predicate));
  }
  return result;
}
function one(root: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode {
  const matches = find(root, predicate); if (matches.length !== 1) throw invalid(); return matches[0];
}
function text(root: HtmlNode): string {
  function content(node: HtmlNode): string {
    if (['script', 'style', 'svg'].includes(node.tag) || hasClass(node, 'tt-child-count')) return '';
    return node.children.map(child => typeof child === 'string' ? child : content(child)).join('');
  }
  return decode(content(root)).replace(/\s+/g, ' ').trim();
}
function field(root: HtmlNode, limit: number): string {
  const value = text(root);
  if (!value || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  return value;
}
function dateNumber(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const number = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(number) && new Date(number).toISOString().slice(0, 10) === value ? number : null;
}
function rowDate(value: string, providerDate: string): string {
  const match = /^(\d{1,2}) ([A-Z][a-z]{2})$/.exec(value), month = match ? MONTHS.indexOf(match[2]) + 1 : 0;
  if (!match || !month) throw invalid();
  const year = Number(providerDate.slice(0, 4)), base = dateNumber(providerDate)!;
  const candidates = [year - 1, year, year + 1].map(candidate => candidate + '-' + String(month).padStart(2, '0') + '-' + match[1].padStart(2, '0'))
    .filter(candidate => { const at = dateNumber(candidate); return at !== null && Math.abs(at - base) <= 2 * 86400000; });
  if (candidates.length !== 1) throw invalid();
  return candidates[0];
}

export function parseWillardBoard(html: string, kind: WillardBoardKind, now: Date = new Date()): WillardBoard {
  if (typeof html !== 'string' || html.length === 0 || html.length > MAX_BYTES || Buffer.byteLength(html, 'utf8') > MAX_BYTES
    || !['arrivals', 'departures'].includes(kind) || !Number.isFinite(now.getTime())) throw invalid();
  const root = tree(html), main = one(root, node => node.tag === 'main' && node.attrs.id === 'content');
  const title = text(one(root, node => node.tag === 'title'));
  const label = kind === 'arrivals' ? 'Arrivals' : 'Departures';
  if (title !== 'CMI • Champaign/Urbana University of Illinois Willard - Live ' + label
    || text(one(main, node => node.tag === 'h1')) !== 'Champaign/Urbana University of Illinois Willard Airport (CMI) — Live ' + kind + ' board') throw invalid();
  const canonical = one(root, node => node.tag === 'link' && node.attrs.rel === 'canonical');
  if (canonical.attrs.href !== 'https://www.avionio.com/en/airport/cmi/' + kind) throw invalid();
  const providerDate = one(main, node => node.attrs.id === 'tt-date').attrs['data-value'];
  if (!providerDate || dateNumber(providerDate) === null) throw invalid();
  const parts = Object.fromEntries(centralCalendar.formatToParts(now).map(part => [part.type, part.value]));
  if (providerDate !== parts.year + '-' + parts.month + '-' + parts.day) throw new Error('Avionio board calendar is not the current Central day.');
  const table = one(main, node => node.tag === 'table' && hasClass(node, 'tt'));
  if (find(main, node => node.tag === 'table').length !== 1) throw invalid();
  const head = one(table, node => node.tag === 'thead'), body = one(table, node => node.tag === 'tbody');
  const headers = find(head, node => node.tag === 'th').map(node => text(node));
  const expected = ['Time', 'Date', 'IATA', kind === 'arrivals' ? 'Origin' : 'Destination', 'Flight', 'Airline', 'Status'];
  if (headers.join('|') !== expected.join('|')) throw invalid();
  const rows = body.children.filter((node): node is HtmlNode => typeof node !== 'string');
  if (rows.some(row => row.tag !== 'tr') || find(body, node => node.tag === 'tr').length !== rows.length) throw invalid();
  const flights: WillardFlight[] = [], ids = new Set<string>();
  for (const row of rows) {
    if (hasClass(row, 'tt-nav')) {
      // A previous-flights link is navigation, not an empty/flight record.
      if (row.attrs.id !== 'tt-nav-prev' || find(row, node => node.tag === 'td').length !== 1) throw invalid();
      continue;
    }
    if (!hasClass(row, 'tt-row') || flights.length === MAX_FLIGHTS) throw invalid();
    const cells = row.children.filter((node): node is HtmlNode => typeof node !== 'string');
    if (cells.length !== 7 || cells.some(cell => cell.tag !== 'td')) throw invalid();
    const names = ['tt-t', 'tt-d', 'tt-i', 'tt-ap', 'tt-f', 'tt-al', 'tt-s'];
    if (cells.some((cell, index) => !hasClass(cell, names[index]))) throw invalid();
    const time = field(cells[0], 5), date = rowDate(field(cells[1], 12), providerDate), iata = field(cells[2], 3);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || !/^[A-Z]{3}$/.test(iata)) throw invalid();
    const anchor = one(cells[4], node => node.tag === 'a' && hasClass(node, 'flight-ts'));
    const flight = field(cells[4], 12), token = anchor.attrs['data-ts'];
    if (!/^[A-Z0-9]{2,12}$/.test(flight) || !/^\d{10,16}$/.test(token || '')
      || !/^\/en\/flight\/[a-z0-9]+-[a-z0-9]+$/.test(anchor.attrs.href || '')
      || anchor.attrs.href.split('/').pop()!.replaceAll('-', '').toUpperCase() !== flight) throw invalid();
    const airportLink = one(cells[2], node => node.tag === 'a');
    if (airportLink.attrs.href !== '/en/airport/' + iata.toLowerCase() + '/' + (kind === 'arrivals' ? 'departures' : 'arrivals')) throw invalid();
    const id = [kind, flight, date, time, token].join(':');
    if (ids.has(id)) throw invalid(); ids.add(id);
    flights.push({ id, flight, airline: field(cells[5], 120), location: field(cells[3], 120), iata, date, time, status: field(cells[6], 160) });
  }
  // No actual provider empty-state marker has been verified. Never turn an
  // empty/changed/challenge page into a reassuring zero-flight response.
  if (!flights.length) throw new Error('Avionio did not provide verified flight records.');
  return { providerDate, flights, explicitEmpty: false };
}
