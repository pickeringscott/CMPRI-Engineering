import "server-only";
import { NextRequest } from "next/server";
import { z } from "zod";
import { searchAskEquipmentSources } from "./ask-cmpri-public-search";
import { askPublicDocumentUrl } from "./ask-cmpri-public-document";

const schema = z.object({
  intent: z.enum(["manual", "manufacturer", "error-code"]),
  assetId: z.string().uuid().optional(), manufacturer: z.string().max(200).optional(), model: z.string().max(200).optional(),
  errorCode: z.string().max(40).optional(), vendorUrl: z.string().max(4000).optional(),
}).strict();
export type AskNativeEquipmentSearch = z.infer<typeof schema>;
type SearchContext = {
  /** Only the current user question and actor/property-signed earlier user turns. Never record text or model output. */
  userTurns: readonly string[];
  /** Actual retrieved public URLs or explicit user URLs already accepted by the native conversation. */
  publicSources?: ReadonlySet<string>;
  signal: AbortSignal;
};

const privateTerm = /\b(?:guests?|reservations?|confirmations?|loyalty|membership|serial|password|passwd|passcode|pin|credentials?|tokens?|bearer|emails?|phones?|address|ssn|rooms?|hotels?|property|private|hu[eé]sped(?:es)?|reservas?|confirmaci[oó]n|habitaci[oó]n|serie|contrase[ñn]a|correo|tel[eé]fono|privad[oa])\b/i;
const privateLabel = "(?:guest(?:\\s+(?:name|code|id|note|message))?|customer(?:\\s+(?:name|code|id))?|reservation(?:\\s+(?:number|code|id))?|confirmation(?:\\s+(?:number|code))?|loyalty(?:\\s+(?:number|code|id))?|membership(?:\\s+(?:number|code|id))?|serial(?:\\s+(?:number|no\\.?|code))?|s\\s*/\\s*n|room(?:\\s+(?:number|code))?|(?:door|access|key)\\s+code|pin|passcode|hotel|property|password|token|email|phone|address|private(?:\\s+label)?)";
const beforePrivate = new RegExp("\\b" + privateLabel + "\\s*(?:(?:is|was)\\s*)?[:=#-]?\\s*[\"']?$", "i");
const afterPrivate = new RegExp("^\\s*[\"']?\\s*(?:is|was|=|:)\\s*(?:the\\s+|a\\s+|my\\s+)?" + privateLabel + "\\b", "i");
const privatePayload = /(?:^|[;\r\n])\s*(?:guest (?:note|message)|staff note|record (?:text|contents?)|private (?:note|label))\s*[:=][^;\r\n]*$/i;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const literal = (value: string) => value.split(/\s+/).map(escape).join("\\s+");

function publicField(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Choose the public equipment ${label}.`);
  const clean = value.trim().replace(/ +/g, " ");
  if (!clean || clean.length > maximum || !/[\p{L}\p{N}]/u.test(clean)
    || !/^[\p{L}\p{N} ._+&'()\/-]+$/u.test(clean) || privateTerm.test(clean)) {
    throw new Error(`Choose the public equipment ${label}, without serials or private labels.`);
  }
  return clean;
}

function occurrences(turn: string, value: string): { start: number; end: number }[] {
  const expression = new RegExp("(?<![\\p{L}\\p{N}_])" + literal(value) + "(?![\\p{L}\\p{N}_])", "giu");
  return [...turn.matchAll(expression)].map(match => ({ start: match.index, end: match.index + match[0].length }));
}

function isPrivateOccurrence(turn: string, start: number, end: number): boolean {
  const before = turn.slice(Math.max(0, start - 240), start), after = turn.slice(end, end + 100);
  return beforePrivate.test(before) || afterPrivate.test(after) || privatePayload.test(before);
}

function explicitField(turns: readonly string[], value: string, label: RegExp): boolean {
  return turns.some(turn => occurrences(turn, value).some(({ start, end }) =>
    !isPrivateOccurrence(turn, start, end) && label.test(turn.slice(Math.max(0, start - 55), start))));
}

function explicitIdentity(turns: readonly string[], manufacturer: string, model: string): boolean {
  const labelled = explicitField(turns, manufacturer, /\b(?:manufacturer|maker|make|brand|fabricante|marca)(?:\s+name)?\s*(?:(?:is|es)\s*)?[:=]?\s*["']?$/i)
    && explicitField(turns, model, /\b(?:model(?:\s+(?:number|no\.?))?|modelo)\s*(?:(?:is|es)\s*)?[:=#]?\s*["']?$/i);
  if (labelled) return true;
  return turns.some(turn => occurrences(turn, manufacturer).some(maker => occurrences(turn, model).some(item => {
    if (isPrivateOccurrence(turn, maker.start, maker.end) || isPrivateOccurrence(turn, item.start, item.end)) return false;
    if (maker.end <= item.start) return /^[\s,:/-]*(?:(?:model(?:\s+(?:number|no\.?))?|modelo)\s*[:=#]?\s*)?$/i.test(turn.slice(maker.end, item.start));
    return item.end <= maker.start && /^\s+(?:by|from|made by)\s+$/i.test(turn.slice(item.end, maker.start));
  })));
}

function explicitErrorCode(turns: readonly string[], code: string, manufacturer: string, model: string): boolean {
  return turns.some(turn => occurrences(turn, code).some(({ start, end }) => {
    if (isPrivateOccurrence(turn, start, end)) return false;
    const before = turn.slice(Math.max(0, start - 70), start);
    if (/\b(?:error|fault|diagnostic|trouble)(?:\s+code)?\s*(?:is\s*)?[:=#-]?\s*["']?$/i.test(before)) return true;
    if (!privateTerm.test(before) && /\b(?:code|display(?:s|ed)?|show(?:s|ing)?)\s*(?:is\s*)?[:=#-]?\s*["']?$/i.test(before)) return true;
    // A compact follow-up such as "What does F3E1 mean?" is explicit user input.
    // A reservation/room/serial value in a longer record is never evidence for a code.
    return /[a-z]/i.test(code) && /\d/.test(code) && !privateTerm.test(turn)
      && (turn.length <= 80 || explicitIdentity([turn], manufacturer, model));
  }));
}

/** Public queries use freshly authorized native identity or explicit signed user identifiers, never model assertions. */
export async function searchAskNativeEquipment(request: NextRequest, input: AskNativeEquipmentSearch, context: SearchContext) {
  const params = schema.parse(input);
  context.signal.throwIfAborted();
  let manufacturer: string, model: string;
  if (params.assetId) {
    const { GET } = await import("@/app/api/assets/route");
    const authorization = request.headers.get("authorization");
    const response = await GET(new NextRequest(new URL("/api/assets?scope=property&include_documentation=false", request.url), {
      headers: authorization ? { authorization } : {}, signal: context.signal,
    }));
    if (!response.ok) throw new Error("Your current CMPRI account cannot read this equipment.");
    const result = await response.json() as { assets?: Record<string, unknown>[] };
    const asset = Array.isArray(result.assets) ? result.assets.find(item => item?.id === params.assetId) : undefined;
    if (!asset) throw new Error("The selected equipment is not available to this CMPRI account.");
    manufacturer = publicField(asset.manufacturer, "manufacturer");
    model = publicField(typeof asset.model_number === "string" && asset.model_number.trim() ? asset.model_number : asset.model_family, "model");
    if (typeof asset.serial_number === "string" && model.toLocaleLowerCase() === asset.serial_number.trim().toLocaleLowerCase()) {
      throw new Error("The saved model matches the asset's serial number. Verify its public model before searching.");
    }
    if (params.manufacturer && params.manufacturer.trim().toLocaleLowerCase() !== manufacturer.toLocaleLowerCase()
      || params.model && params.model.trim().toLocaleLowerCase() !== model.toLocaleLowerCase()) {
      throw new Error("The requested equipment identity differs from the current native asset. Use its current manufacturer and model.");
    }
  } else {
    manufacturer = publicField(params.manufacturer, "manufacturer");
    model = publicField(params.model, "model");
    if (!explicitIdentity(context.userTurns, manufacturer, model)) {
      throw new Error("Supply the exact public manufacturer and model in your question, or select the current native asset.");
    }
  }
  const errorCode = params.intent === "error-code" ? publicField(params.errorCode, "error code", 40) : undefined;
  if (errorCode && !explicitErrorCode(context.userTurns, errorCode, manufacturer, model)) {
    throw new Error("Supply the equipment's actual error code in your question; a record, guest code or serial cannot authorize a public search.");
  }
  let vendorDomain: string | undefined;
  if (params.vendorUrl) {
    const url = askPublicDocumentUrl(params.vendorUrl);
    if (!context.publicSources?.has(url.href)) throw new Error("Choose a public vendor URL supplied by the user or returned by the current search.");
    vendorDomain = url.hostname;
  }
  context.signal.throwIfAborted();
  const items = await searchAskEquipmentSources({ manufacturer, model, intent: params.intent, ...(errorCode ? { errorCode } : {}), ...(vendorDomain ? { vendorDomain } : {}) }, context.signal);
  return { ...(params.assetId ? { assetId: params.assetId } : {}), manufacturer, model, ...(errorCode ? { errorCode } : {}), items };
}
