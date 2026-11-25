import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import type { AskLanguage, AskProposal, AskResponse, AskResultItem } from "@/lib/ask-cmpri/types";
import type { AuthAttempt } from "@/lib/server/auth";
import type { Principal } from "@/lib/server/access";
import { manualPreviewReadOnly } from "@/lib/server/manual-preview";
import { STAFF_FILE_BUCKET } from "@/lib/staff-note-media";
import { askNativeOperation, type AskNativeOperation } from "./ask-cmpri-native-catalog";

type Authorized = Extract<AuthAttempt, { ok: true }>;
export type AskNativeRequest = { operation: string; parameters?: Record<string, string>; query?: Record<string, string | string[]>; body?: unknown; files?: Record<string, string> };
export type AskNativeRead = { ok: boolean; status: number; data?: unknown; error?: string; downloads?: AskResponse["downloads"]; operation: string; screen: string; source: string; sourceScope?: string };
const pairRecord = z.record(z.string().max(100), z.string().max(4000));
const requestSchema = z.object({ operation: z.string().min(1).max(200), parameters: pairRecord.optional(), query: z.record(z.string().max(100), z.union([z.string().max(4000), z.array(z.string().max(4000))])).optional(), body: z.unknown().optional(), files: z.record(z.string().min(1).max(100), z.string().min(1).max(10000)).optional() });
const signedSchema = z.object({
  version: z.literal(1), actor: z.string().uuid(), hotel: z.string().uuid(), requestId: z.string().uuid(),
  expires: z.number().int(), language: z.enum(["en", "es"]), label: z.string().max(200),
  requests: z.array(requestSchema).min(1).max(50),
});
type Signed = z.infer<typeof signedSchema>;
const context = "cmpri-ask-native-confirmation:v1:";
const tokenPrefix = "native.";

export function askNativeScreen(operation: Pick<AskNativeOperation, "path">) {
  const path = operation.path;
  const mappings: [string, string][] = [
    ["/api/work-orders", "/work-orders"], ["/api/preventive-maintenance", "/engineering/preventive-maintenance"],
    ["/api/corporate-pm", "/engineering/preventive-maintenance"], ["/api/room-operations", "/engineering/room-operations"],
    ["/api/guest-reports", "/engineering/room-operations"], ["/api/ticket-room-ranker", "/engineering/room-ranking"],
    ["/api/rooms", "/management/rooms"], ["/api/assets", "/management/equipment"], ["/api/maintenance-reference", "/management/equipment"],
    ["/api/engineering/catalog", "/engineering/parts"], ["/api/engineering/inventory", "/engineering/parts"],
    ["/api/engineering/supply-use", "/engineering/parts"], ["/api/engineering/gss", "/engineering/gss"],
    ["/api/engineering", "/engineering/purchasing"], ["/api/integrations/drive-po", "/engineering/drive-po"],
    ["/api/integrations/email", "/engineering/purchasing"], ["/api/enseo", "/engineering/enseo-assignments"],
    ["/api/pool-log", "/engineering/pool-log"], ["/api/pool-status", "/pool"], ["/api/winter-preparedness", "/engineering/winter-preparedness"],
    ["/api/notepad", "/notepad"], ["/api/ask-cmpri/notepad-patch", "/notepad"], ["/api/ask-cmpri/native-files/notepad", "/notepad"],
    ["/api/staff-notes", "/notepad"], ["/api/notes", "/notepad"], ["/api/hours-tracker", "/engineering/hours-tracker"],
    ["/api/profile", "/profile"], ["/api/users", "/management/users"], ["/api/employment", "/engineering/employment"],
    ["/api/feedback", "/feedback"], ["/api/ask-cmpri/help", "/setup-guide"],
    ["/api/weather-preview", "/previews/cmpri-weather-preview.html"],
    ["/api/willard-flights", "/previews/cmpri-weather-preview.html"], ["/api/willard-tracker", "/previews/cmpri-weather-preview.html"],
    ["/api/willard-airport-layout", "/previews/cmpri-weather-preview.html"],
  ];
  return mappings.find(([prefix]) => path === prefix || path.startsWith(prefix + "/"))?.[1] || "/engineering";
}

const secretKey = /^(?:token|(?:access|refresh|id|auth|bearer|session|reset|invite|verification)_?token|(?:supabase_?)?(?:service_?role_?key|anon_?key)|(?:[a-z]+_?)?api_?key|(?:[a-z]+_?)?secret|(?:[a-z]+_?)?password(?:_?hash)?|authorization|cookie|private_?key)$/i;
class AskNativeInputError extends Error {}
function redactCredentialText(value: string) {
  return value.replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, "$1 [redacted]")
    .replace(/([?&](?:access_token|refresh_token|token|api_key|key|client_secret|password)=)[^&#\s"']+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, "$1[redacted]@");
}
/** Native responses remain private; authentication credentials never become model context. */
export function redactAskNativeCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAskNativeCredentials);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !secretKey.test(key) && !["__proto__", "prototype", "constructor"].includes(key))
    .map(([key, item]) => [key, redactAskNativeCredentials(item)]));
  return typeof value === "string" ? redactCredentialText(value) : value;
}

export function askNativeRequestUrl(incoming: NextRequest, operation: AskNativeOperation, input: AskNativeRequest) {
  const supplied = input.parameters || {};
  if (Object.keys(supplied).some(key => !operation.pathParams.includes(key))) throw new AskNativeInputError("Unknown CMPRI record parameter.");
  let path = operation.path;
  for (const key of operation.pathParams) {
    const value = supplied[key];
    if (!value || value === "." || value === ".." || /[\\/\x00-\x1f]/.test(value)) throw new AskNativeInputError(`A valid ${key} is required.`);
    path = path.replace(`[${key}]`, encodeURIComponent(value));
  }
  if (path.includes("[") || !path.startsWith("/api/")) throw new AskNativeInputError("CMPRI operation route is unavailable.");
  const url = new URL(path, incoming.url);
  for (const [key, value] of Object.entries(input.query || {})) {
    if (!operation.queryParams.includes(key)) throw new AskNativeInputError(`This operation does not accept ${key}.`);
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
  }
  return url;
}

function nativeError(status: number, body: unknown) {
  if (status === 401) return "Your CMPRI session must be renewed before this request can continue.";
  if (status === 403) return "Your current CMPRI role does not permit this operation.";
  if (body && typeof body === "object") {
    const data = body as Record<string, unknown>;
    const error = data.error;
    const message = typeof error === "string" ? error : error && typeof error === "object" ? (error as Record<string, unknown>).message : data.message || data.reason;
    if (typeof message === "string") return message.slice(0, 2000);
  }
  return `The CMPRI operation returned status ${status}.`;
}

function nativeDownloadName(disposition: string) {
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;\r\n]+)/i)?.[1];
  let name: string | undefined;
  if (encoded) try { name = decodeURIComponent(encoded.trim()); } catch { /* Use the native ASCII fallback below. */ }
  name ||= disposition.match(/filename\s*=\s*(?:"([^"\r\n]+)"|([^;\r\n]+))/i)?.slice(1).find(Boolean)?.trim();
  return name && !/[\\/\x00-\x1f\x7f]/.test(name) ? name.slice(0, 255) : "CMPRI-export";
}

/** No service credential is forwarded. Native handlers enforce their existing
 * permissions; public Weather sources also require the Weather modal's role
 * admission here, before Ask can read them on the signed-in user's behalf. */
export async function runAskNativeRequest(incoming: NextRequest, input: AskNativeRequest, allowWrite = false): Promise<AskNativeRead> {
  const operation = askNativeOperation(input.operation);
  if (!operation) return { ok: false, status: 400, operation: input.operation, screen: "/engineering", source: "CMPRI", error: "Unknown CMPRI operation. Discover its native operation first." };
  const base = { operation: operation.key, screen: askNativeScreen(operation), source: "CMPRI · " + operation.domain };
  if (operation.writes && !allowWrite) return { ...base, ok: false, status: 409, error: "Review the proposed change before applying it." };
  if (operation.writes && manualPreviewReadOnly()) return { ...base, ok: false, status: 403, error: "Changes are disabled in this read-only preview." };
  try {
    const url = askNativeRequestUrl(incoming, operation, input);
    const authorization = incoming.headers.get("authorization");
    if (!authorization) return { ...base, ok: false, status: 401, error: "Sign in to use CMPRI." };
    const bodyKind = "bodyKind" in operation ? operation.bodyKind : "json";
    let body: BodyInit | undefined;
    const headers = new Headers({ authorization });
    const fileFields = Object.entries(input.files || {});
    if (fileFields.length > 20) throw new AskNativeInputError("Select at most 20 original files for one form.");
    if (fileFields.length && (operation.method === "GET" || !["multipart", "json-or-multipart"].includes(bodyKind))) throw new AskNativeInputError("This operation does not accept original file fields. Use its native source-file operation.");
    if ((input.body !== undefined || fileFields.length) && operation.method !== "GET") {
      if (bodyKind === "multipart" || fileFields.length) {
        const form = new FormData();
        if (input.body !== undefined && (!input.body || typeof input.body !== "object" || Array.isArray(input.body))) throw new AskNativeInputError("This CMPRI form requires named fields.");
        for (const [key, value] of Object.entries(input.body || {})) {
          if (Object.hasOwn(input.files || {}, key)) throw new AskNativeInputError("An original file field cannot also contain a text value.");
          if (typeof value === "string") form.set(key, value);
          else if (typeof value === "number" || typeof value === "boolean") form.set(key, String(value));
          else throw new AskNativeInputError("Attach the original file using this CMPRI module's file control. File contents cannot be inferred from a description.");
        }
        if (fileFields.length) {
          const { readAskStagedFile } = await import("./ask-cmpri-file-staging");
          for (const [field, token] of fileFields) {
            if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(field)) throw new AskNativeInputError("Choose a valid native file field.");
            const original = await readAskStagedFile(incoming, token);
            form.set(field, original.file, original.descriptor.name);
            if (operation.key === "work_order_attachments.add" && field === "photo") headers.set("x-upload-id", original.descriptor.id);
          }
        }
        body = form;
      } else {
        headers.set("content-type", "application/json");
        body = JSON.stringify(input.body);
      }
    }
    const delegated = new NextRequest(url, { method: operation.method, headers, body, signal: incoming.signal });
    if (base.screen === "/previews/cmpri-weather-preview.html") {
      // These public source routes deliberately remain public for the native
      // Weather screen. Ask must check its current caller on every lookup,
      // including map, astronomy and Airport sources from that same modal.
      const { requireUserAttempt } = await import("@/lib/server/auth");
      const { canOpenWeather } = await import("@/lib/dashboard/menu-access");
      const auth = await requireUserAttempt(delegated);
      if (!auth.ok || auth.mcp) return { ...base, ok: false, status: 401, error: "Sign in to use CMPRI Weather." };
      if (!canOpenWeather(auth.principal.profile)) return { ...base, ok: false, status: 403,
        error: "Your current CMPRI role does not permit access to the Weather modal." };
    }
    const response = await operation.run(delegated, input.parameters || {});
    if (!response) throw new Error("CMPRI returned no operation result.");
    const mime = response.headers.get("content-type") || "";
    const disposition = response.headers.get("content-disposition") || "";
    if (mime.includes("json") && !/^attachment\b/i.test(disposition)) {
      const raw = await response.json();
      let downloads: AskResponse["downloads"];
      if (response.ok && operation.key === "employment.resume" && raw && typeof raw === "object" && !Array.isArray(raw)) {
        const original = raw.originalDownload;
        delete raw.originalDownload;
        if (original && typeof original.id === "string" && typeof original.name === "string"
          && typeof original.mimeType === "string" && typeof original.content === "string" && original.encoding === "base64") {
          downloads = [{ id: original.id, name: original.name, mimeType: original.mimeType, content: original.content, encoding: "base64" }];
        }
      }
      const data = redactAskNativeCredentials(raw);
      const result = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
      // Weather/Airport may intentionally retain usable, explicitly marked stale/partial data.
      const retained = result.status === "partial" || result.status === "stale";
      const rejected = result.success === false || result.ok === false || result.unavailable === true || Boolean(result.error) && !retained;
      return response.ok && !rejected ? { ...base, ok: true, status: response.status, data, ...(downloads ? { downloads } : {}) }
        : { ...base, ok: false, status: rejected && response.ok ? 422 : response.status, data, error: nativeError(response.status, data) };
    }
    if (!response.ok) return { ...base, ok: false, status: response.status, error: nativeError(response.status, null) };
    if (response.status === 204) return { ...base, ok: true, status: 204, data: { success: true } };
    if (disposition.includes("attachment") || !mime.startsWith("text/") && !mime.includes("xml")) {
      const bytes = Buffer.from(await response.arrayBuffer());
      const name = nativeDownloadName(disposition);
      const sourceScope = response.headers.get("x-cmpri-export-source")?.slice(0, 1000) || undefined;
      return { ...base, ok: true, status: response.status, sourceScope, data: { fileName: name, mimeType: mime, size: bytes.length, ...(sourceScope ? { sourceScope } : {}) },
        downloads: [{ id: randomUUID(), name, mimeType: mime || "application/octet-stream", content: bytes.toString("base64"), encoding: "base64" }] };
    }
    return { ...base, ok: true, status: response.status, data: { text: await response.text() } };
  } catch (error) {
    if (incoming.signal.aborted) throw error;
    return { ...base, ok: false, status: error instanceof AskNativeInputError ? 400 : 502,
      error: error instanceof AskNativeInputError ? error.message : "The CMPRI operation is temporarily unavailable." };
  }
}

function signature(payload: string) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("CMPRI confirmation is not configured.");
  return createHmac("sha256", secret).update(context).update(payload).digest();
}

export function isAskNativeConfirmation(token: string) { return token.startsWith(tokenPrefix); }

export function beginAskNativeChange(principal: Principal, requests: AskNativeRequest[], language: AskLanguage, label: string): AskProposal {
  if (!requests.length || requests.some(input => !askNativeOperation(input.operation)?.writes)) throw new Error("Choose a native CMPRI change operation.");
  const action = signedSchema.parse({ version: 1, actor: principal.identity.id, hotel: principal.hotelId, requestId: randomUUID(),
    expires: Date.now() + 12 * 60_000, language, label, requests });
  const payload = Buffer.from(JSON.stringify(action)).toString("base64url");
  const token = tokenPrefix + payload + "." + signature(payload).toString("base64url");
  if (token.length > 320_000) throw new Error("Use the native import control for this large change.");
  const details = requests.map(input => ({ action: askNativeOperation(input.operation)!.description, ...input.parameters, ...input.query, values: redactAskNativeCredentials(input.body) }));
  return { id: action.requestId, field: "cmpri", label, from: "", to: JSON.stringify(details, null, 2), token,
    effects: [language === "es" ? "CMPRI comprobará tus permisos actuales y validará cada cambio al confirmar." : "CMPRI will check your current role permissions and validate each change when confirmed."] };
}

export function verifyAskNativeChange(token: string, principal: Principal, allowExpired = false): Signed | null {
  if (!isAskNativeConfirmation(token)) return null;
  const [payload, provided, extra] = token.slice(tokenPrefix.length).split(".");
  if (!payload || !provided || extra !== undefined) return null;
  try {
    const actual = Buffer.from(provided, "base64url"), expected = signature(payload);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const decoded = signedSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (!decoded.success) return null;
    const value = decoded.data;
    if (value.actor !== principal.identity.id || value.hotel !== principal.hotelId || !allowExpired && value.expires <= Date.now()) return null;
    if (value.requests.some(input => !askNativeOperation(input.operation)?.writes)) return null;
    return value;
  } catch { return null; }
}

export function nativeReadItem(read: AskNativeRead, id: string, text?: string): AskResultItem {
  return { id, title: read.source, source: read.source, sourceType: "internal", text: text || read.error,
    record: { kind: "module", id: read.screen, label: "Open " + read.source.replace(/^CMPRI · /, "") } };
}

function nativeOutcome(read: AskNativeRead) {
  if (!read.ok) return read.error || "CMPRI did not complete this operation.";
  const data = read.data && typeof read.data === "object" && !Array.isArray(read.data) ? read.data as Record<string, unknown> : {};
  const messages: string[] = [];
  if (read.status === 202) messages.push("CMPRI accepted the request for processing; completion is pending.");
  else if (data.unchanged === true) messages.push("CMPRI reports that the existing record is unchanged.");
  else messages.push("CMPRI confirmed this operation completed.");
  if (data.closure_required === true) messages.push("The pool must remain CLOSED.");
  for (const [key, label] of [["closure_reasons", "Closure reason"], ["warnings", "Warning"], ["conflicts", "Conflict"]]) {
    const value = data[key];
    for (const item of Array.isArray(value) ? value : typeof value === "string" ? [value] : []) {
      if (typeof item === "string" && item.trim()) messages.push(`${label}: ${item}`);
    }
  }
  if (typeof data.message === "string") messages.push(data.message);
  const status = data.status;
  if (typeof status === "string") messages.push("Status: " + status);
  else if (status && typeof status === "object") {
    const state = status as Record<string, unknown>;
    for (const key of ["label", "reason", "message"]) if (typeof state[key] === "string") messages.push(String(state[key]));
    if (Array.isArray(state.daily_checks_missing) && state.daily_checks_missing.length) messages.push("Daily checks still required: " + state.daily_checks_missing.join(", "));
  }
  return [...new Set(messages)].join(" ");
}

/** Atomic claim markers prevent retries, cancellation races, or replay from repeating a write. */
export async function confirmAskNativeChange(request: NextRequest, auth: Authorized, token: string, options: { cancel?: boolean; recover?: boolean } = {}) {
  const action = verifyAskNativeChange(token, auth.principal, true);
  const failure = (summary: string, status = 409) => ({ status, result: { title: "CMPRI change status", summary } as AskResponse });
  if (!action) return failure("This confirmation does not belong to the current CMPRI session. Review the change again.");
  const storage = auth.admin.storage.from(STAFF_FILE_BUCKET);
  const prefix = `ask-confirmations/native-v1/${action.hotel}/${action.actor}/${action.requestId}`;
  const cancelled = () => ({ status: 200, result: { title: action.language === "es" ? "Cambio cancelado" : "Change cancelled", summary: action.language === "es" ? "La propuesta fue cancelada." : "The proposed change was cancelled." } as AskResponse });
  const pending = () => failure("The outcome of this confirmed change has not yet been verified. Check its CMPRI record before submitting another change.");
  async function readMarker(name: string): Promise<string | null> {
    const stored = await storage.download(`${prefix}/${name}`);
    if (stored.error) {
      const error = stored.error as { statusCode?: string; status?: string; message?: string; originalError?: { status?: number } };
      if (String(error.statusCode || error.status || error.originalError?.status) === "404" || /not found|NoSuchKey/i.test(error.message || "")) return null;
      throw stored.error;
    }
    return stored.data ? await stored.data.text() : null;
  }
  async function recover() {
    const saved = await readMarker("result");
    if (!saved) return pending();
    const outcome = JSON.parse(saved) as { status: number; result: AskResponse };
    // Results retain only completion labels; private records are read again under current roles.
    return outcome;
  }
  try {
    const claim = await readMarker("claim");
    if (claim === "cancel") return options.cancel ? cancelled() : failure("This proposed change was cancelled.");
    if (claim === "confirm") return recover();
    if (options.recover || action.expires <= Date.now()) return failure("This proposal expired or was never confirmed. Review a new proposal.");
    if (!options.cancel && manualPreviewReadOnly()) return failure("Changes are disabled in this read-only preview.", 403);
    const locked = await storage.upload(`${prefix}/claim`, options.cancel ? "cancel" : "confirm", { upsert: false, contentType: "text/plain" });
    if (locked.error) {
      const raced = await readMarker("claim");
      return raced === "confirm" ? recover() : raced === "cancel" ? cancelled() : failure("The change could not be reserved for confirmation.", 503);
    }
    if (options.cancel) return cancelled();
    const results: AskNativeRead[] = [];
    // Stop at an asynchronous acceptance: a later change may depend on its completion.
    for (const input of action.requests) {
      const read = await runAskNativeRequest(request, input, true);
      results.push(read);
      if (!read.ok || read.status === 202) break;
    }
    const isUnchanged = (read: AskNativeRead) => read.ok && read.status !== 202
      && Boolean(read.data && typeof read.data === "object" && (read.data as Record<string, unknown>).unchanged === true);
    const completed = results.filter(read => read.ok && read.status !== 202 && !isUnchanged(read)).length;
    const unchanged = results.filter(isUnchanged).length;
    const failed = results.find(read => !read.ok);
    const accepted = results.some(read => read.ok && read.status === 202);
    const remaining = action.requests.length - results.length;
    const stateSummary = [
      completed ? failed || accepted || remaining ? `${completed} of ${action.requests.length} changes completed in CMPRI.`
        : `${completed} ${completed === 1 ? "change" : "changes"} completed in CMPRI.` : "",
      unchanged ? `${unchanged} ${unchanged === 1 ? "record already matched and is" : "records already matched and are"} unchanged.` : "",
      accepted ? "CMPRI accepted the request for processing; completion is pending." : "",
      failed ? "The last attempted change was not confirmed as applied." : "",
      remaining ? `${remaining} ${remaining === 1 ? "remaining change was" : "remaining changes were"} not submitted.${accepted ? " Review the pending result before submitting them." : ""}` : "",
    ].filter(Boolean).join(" ");
    const result: AskResponse = {
      title: failed ? "CMPRI change needs attention" : accepted ? "CMPRI change pending"
        : completed ? "CMPRI change completed" : "CMPRI records unchanged",
      summary: [stateSummary, ...results.map(nativeOutcome)].join(" "),
      items: results.map((read, index) => nativeReadItem(read, `native-change:${action.requestId}:${index}`, nativeOutcome(read))),
      downloads: results.flatMap(read => read.downloads || []),
      context: { language: action.language, sources: ["cmpri"] },
    };
    const outcome = { status: failed ? failed.status : accepted ? 202 : 200, result };
    const receipt = { status: outcome.status, result: { title: result.title,
      summary: `${stateSummary} Open the CMPRI record for its current status and any warnings.`, context: result.context } };
    await storage.upload(`${prefix}/result`, JSON.stringify(receipt), { upsert: false, contentType: "application/json" }).catch(() => undefined);
    return outcome;
  } catch { return failure("The change outcome could not be verified. Check its CMPRI record before submitting another change.", 503); }
}
