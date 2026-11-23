import "server-only";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const PDF_LIMIT = 100 * 1024 * 1024;
const PAGE_LIMIT = 2 * 1024 * 1024;

/** Public vendor fetching never reaches local, private, link-local or reserved hosts. */
export function isAskPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127
      && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 168 || b === 0 || b === 88 && c === 99))
      && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
      && !(a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const [first, second] = normalized.split(":").map(part => Number.parseInt(part || "0", 16));
    // Global unicast only; exclude documentation, transition and mapped addresses.
    return /^[23][a-f0-9]{3}:/.test(normalized)
      && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
      && first !== 0x2002 && first !== 0x3fff
      && !normalized.includes(".");
  }
  return false;
}

export function askPublicDocumentUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || value.length > 4000
    || !host.includes(".") || host.endsWith(".") || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example)$/.test(host)
    || isIP(host) !== 0
    || [...url.searchParams.keys()].some(key => /^(?:access_token|refresh_token|authorization|password|api_key|apikey|client_secret)$/i.test(key))) {
    throw new Error("Choose a public HTTPS vendor document link without sign-in credentials.");
  }
  url.hash = "";
  return url;
}

type ResponseBytes = { status: number; type: string; disposition: string; location?: string; bytes: Buffer };

/** DNS is validated and pinned on each hop, including redirects. No app headers leave CMPRI. */
async function downloadHop(url: URL, signal: AbortSignal): Promise<ResponseBytes> {
  signal.throwIfAborted();
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !isAskPublicAddress(address))) {
    throw new Error("The vendor link does not resolve to a public document server.");
  }
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: "GET", agent: false, signal, family: selected.family,
      lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
      headers: { Accept: "application/pdf,text/html;q=0.8", "Accept-Encoding": "identity", "User-Agent": "CMPRI-Document-Reader/1.0" },
    }, response => {
      const status = response.statusCode || 502;
      const type = String(response.headers["content-type"] || "").toLowerCase();
      const base = { status, type, disposition: String(response.headers["content-disposition"] || ""), location: response.headers.location };
      if (status >= 300 && status < 400) {
        response.destroy(); resolve({ ...base, bytes: Buffer.alloc(0) }); return;
      }
      if (status < 200 || status >= 300) {
        response.destroy(); reject(new Error(`The vendor document returned status ${status}.`)); return;
      }
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        response.destroy(); reject(new Error("The vendor did not return the original uncompressed file bytes.")); return;
      }
      const limit = type.includes("text/html") ? PAGE_LIMIT : PDF_LIMIT;
      const advertised = Number(response.headers["content-length"] || 0);
      if (advertised > limit) { response.destroy(); reject(new Error("The vendor file exceeds CMPRI's file limit.")); return; }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", chunk => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += part.length;
        if (length > limit) { response.destroy(); reject(new Error("The vendor file exceeds CMPRI's file limit.")); }
        else chunks.push(part);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ ...base, bytes: Buffer.concat(chunks) }));
    });
    req.setTimeout(25_000, () => req.destroy(new Error("The vendor document request timed out.")));
    req.on("error", reject);
    req.end();
  });
}

function safePdfName(url: URL, disposition: string) {
  const raw = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i)?.[1]
    || url.pathname.split("/").pop() || "Vendor-document.pdf";
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* Keep the original safe name. */ }
  const name = decoded.replace(/[^A-Za-z0-9._ -]/g, "-").replace(/^\.+/, "").slice(0, 180) || "Vendor-document.pdf";
  return /\.pdf$/i.test(name) ? name : name + ".pdf";
}

export type AskPublicDocument = { kind: "pdf"; url: string; bytes: Buffer; fileName: string }
  | { kind: "page"; url: string; links: { url: string; label: string }[] };

/** A page may supply real links; it never becomes a pretend PDF download. */
export async function fetchAskPublicDocument(value: string, signal: AbortSignal): Promise<AskPublicDocument> {
  let url = askPublicDocumentUrl(value);
  const limited = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  for (let hop = 0; hop <= 4; hop++) {
    const result = await downloadHop(url, limited);
    if (result.status >= 300 && result.status < 400) {
      if (!result.location || hop === 4) throw new Error("The vendor document link redirected too many times.");
      url = askPublicDocumentUrl(new URL(result.location, url).href);
      continue;
    }
    if (result.bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
      return { kind: "pdf", url: url.href, bytes: result.bytes, fileName: safePdfName(url, result.disposition) };
    }
    if (!result.type.includes("text/html") || result.bytes.length > PAGE_LIMIT) throw new Error("The vendor link did not return a readable PDF or document page.");
    const links = new Map<string, { url: string; label: string }>();
    const html = result.bytes.toString("utf8");
    for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
      try {
        const target = askPublicDocumentUrl(new URL((match[1] || match[2] || match[3]).replace(/&amp;/gi, "&"), url).href);
        const label = match[4].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
        if (/\.pdf(?:\?|$)|manual|document|download|support|literature|service|technical/i.test(target.href + " " + label)) links.set(target.href, { url: target.href, label });
        if (links.size === 80) break;
      } catch { /* Non-public and non-document links are not acquisition choices. */ }
    }
    return { kind: "page", url: url.href, links: [...links.values()] };
  }
  throw new Error("The vendor PDF could not be opened.");
}
