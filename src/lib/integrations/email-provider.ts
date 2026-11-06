import type {PdfEvidence} from "../po-attachment-intake";
import { createHash, timingSafeEqual } from "node:crypto";
/** Read-only message adapters; push setup separately registers provider watches. */
export type EmailProvider = "gmail" | "microsoft365";
export type OperationalMessage = { id: string; threadId?: string; subject: string; from: string; to: string; text: string; html?: string; labelIds?: string[]; pdfEvidence?: PdfEvidence[]; messageAt: string; direction: "inbound" | "outbound" };
type Json = Record<string, unknown>;
const MAX_MESSAGES = 500;

export function configuredEmailProvider(): EmailProvider | null {
  const explicit = (process.env.CMPRI_EMAIL_PROVIDER || "").toLowerCase();
  if (explicit) {
    if (["microsoft365", "microsoft", "outlook"].includes(explicit)) return "microsoft365";
    if (["gmail", "google"].includes(explicit)) return "gmail";
    throw new Error("CMPRI_EMAIL_PROVIDER must be microsoft365 or gmail.");
  }
  if (process.env.CMPRI_MS_TENANT_ID && process.env.CMPRI_MS_CLIENT_ID && process.env.CMPRI_MS_CLIENT_SECRET && process.env.CMPRI_MS_MAILBOX) return "microsoft365";
  if (process.env.CMPRI_GMAIL_CLIENT_ID && process.env.CMPRI_GMAIL_CLIENT_SECRET && process.env.CMPRI_GMAIL_REFRESH_TOKEN) return "gmail";
  return null;
}

export function htmlToText(html: string) {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:br|p|div|tr|li|h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/[ \t]+/g, " ").trim();
}

type MimePart = { partId?: string; filename?: string; mimeType?: string; body?: { data?: string; size?: number; attachmentId?: string }; parts?: MimePart[] };
function gmailHtml(part?: MimePart): string {
 const chunks:string[]=[];const visit=(p?:MimePart)=>{if(p?.mimeType==='text/html'&&p.body?.data)chunks.push(Buffer.from(p.body.data,'base64url').toString('utf8'));for(const child of p?.parts||[])visit(child);};visit(part);return chunks.join('\n');
}
export function gmailText(part?: MimePart): string {
  const plain: string[] = [], html: string[] = [];
  function visit(node?: MimePart) {
    if (!node) return;
    if (node.body?.data) {
      const text = Buffer.from(node.body.data, "base64url").toString("utf8");
      if (node.mimeType === "text/plain") plain.push(text);
      if (node.mimeType === "text/html") html.push(text);
    }
    for (const child of node.parts || []) visit(child);
  }
  visit(part);
  return plain.length ? plain.join("\n").trim() : htmlToText(html.join("\n"));
}

export function messageDirection(from: string, account: string): "inbound" | "outbound" {
  const addresses: string[] = from.toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/g) || [];
  return account && addresses.includes(account.trim().toLowerCase()) ? "outbound" : "inbound";
}

type RequestStage = "OAuth token exchange" | "Gmail list" | "Gmail retrieval" | "Gmail PDF attachment" | "Microsoft messages";
const SAFE_OAUTH_CODES = new Set(["deleted_client", "disabled_client", "invalid_dpop_proof", "use_dpop_nonce", "invalid_client", "invalid_grant", "unauthorized_client", "access_denied", "invalid_request", "unsupported_grant_type", "invalid_scope", "temporarily_unavailable", "server_error"]);
const SAFE_GMAIL_CODES = new Set(["authError", "insufficientPermissions", "accessNotConfigured", "rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "backendError", "notFound", "forbidden", "domainPolicy", "UNAUTHENTICATED", "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "INVALID_ARGUMENT", "NOT_FOUND", "UNAVAILABLE", "INTERNAL"]);
function safeProviderCodes(body: unknown, stage: RequestStage): string[] {
  if (!body || typeof body !== "object" || !("error" in body)) return [];
  const error = body.error;
  if (stage === "OAuth token exchange") return typeof error === "string" && SAFE_OAUTH_CODES.has(error) ? [error] : [];
  if (!stage.startsWith("Gmail") || !error || typeof error !== "object") return [];
  const details = error as { status?: unknown; errors?: unknown };
  const candidates: unknown[] = [details.status];
  if (Array.isArray(details.errors)) for (const item of details.errors) {
    if (item && typeof item === "object" && "reason" in item) candidates.push(item.reason);
  }
  return [...new Set(candidates.filter((code): code is string => typeof code === "string" && SAFE_GMAIL_CODES.has(code)))];
}
// Exact matches only: never copy or partially match untrusted provider text.
// Meanings: https://developers.google.com/identity/protocols/oauth2#expiration
function safeGrantReasons(body: Json) {
  return {
    grantDescriptionReason: body.error_description === "Token has been expired or revoked." ? "expired_or_revoked"
      : body.error_description === "Bad Request" ? "bad_request_unspecified" : "unknown",
    grantSubtypeReason: body.error_subtype === "invalid_rapt" ? "session_control" : "unknown",
  };
}
// Literal labels only; "Unauthorized" does not prove which credential failed.
function safeClientReason(body: Json) {
  return body.error_description === "Unauthorized" ? "unauthorized_unspecified"
    : body.error_description === "The OAuth client was not found." ? "oauth_client_not_found" : "unknown";
}
// Exact text labels only: generic authorization wording does not identify a cause.
function safeUnauthorizedClientReason(body: Json) {
  switch (body.error_description) {
    case "Unauthorized": return "unauthorized_unspecified";
    case "Bad Request": return "bad_request_unspecified";
    case "Unauthorized client or scope in request.": return "client_or_scope_unspecified";
    case "The OAuth client was not found.": return "oauth_client_not_found";
    default: return "unknown";
  }
}
export type MailboxDigestReferences = { clientSecretSha256: string; refreshTokenSha256: string };
type DigestComparison = { references: MailboxDigestReferences; clientSecret: string; refreshToken: string };
function digestMatches(value: string | undefined, reference: string) {
  if (typeof value !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(value, "utf8").digest(), Buffer.from(reference, "hex"));
}
async function jsonRequest(url: string, init: RequestInit, stage: RequestStage, comparison?: DigestComparison): Promise<Json> {
  const gmailTokenRequest = stage === "OAuth token exchange" && url === "https://oauth2.googleapis.com/token" && init.body instanceof URLSearchParams;
  // Compare the exact form string passed to fetch, not a later environment lookup.
  const requestBody = gmailTokenRequest ? (init.body as URLSearchParams).toString() : init.body;
  const clientIds = gmailTokenRequest ? new URLSearchParams(requestBody as string).getAll("client_id") : [];
  const runtimeRefreshToken = gmailTokenRequest ? process.env.CMPRI_GMAIL_REFRESH_TOKEN : undefined;
  const requestRefreshTokens = gmailTokenRequest ? new URLSearchParams(requestBody as string).getAll("refresh_token") : [];
  // Snapshot before fetch; diagnostics never normalize or change the sent token.
  const tokenShape = {
    refreshTokenHasEdgeWhitespace: typeof runtimeRefreshToken === "string" && runtimeRefreshToken !== runtimeRefreshToken.trim(),
    requestRefreshTokenMatchesRuntime: typeof runtimeRefreshToken === "string" && requestRefreshTokens.length === 1 && requestRefreshTokens[0] === runtimeRefreshToken,
  };
  const runtimeClientSecret = gmailTokenRequest ? process.env.CMPRI_GMAIL_CLIENT_SECRET : undefined;
  const requestClientSecrets = gmailTokenRequest ? new URLSearchParams(requestBody as string).getAll("client_secret") : [];
  const clientSecretShape = {
    clientSecretHasEdgeWhitespace: typeof runtimeClientSecret === "string" && runtimeClientSecret !== runtimeClientSecret.trim(),
    requestClientSecretMatchesRuntime: typeof runtimeClientSecret === "string" && requestClientSecrets.length === 1 && requestClientSecrets[0] === runtimeClientSecret,
  };
  const clientIdCheck = gmailTokenRequest ? {
    requestClientIdMatchesRuntime: clientIds.length === 1 && clientIds[0] === process.env.CMPRI_GMAIL_CLIENT_ID,
  } : {};
  // Diagnostic exits at the SAME serialization boundary as the normal fetch.
  // No Google request, logging, digest output, or persistence on this branch.
  if (comparison) {
    if (!gmailTokenRequest) throw new Error("Mailbox comparison unavailable.");
    return {
      sourceClientSecretMatchesReference: digestMatches(comparison.clientSecret, comparison.references.clientSecretSha256),
      outgoingClientSecretMatchesReference: requestClientSecrets.length === 1 && digestMatches(requestClientSecrets[0], comparison.references.clientSecretSha256),
      sourceRefreshTokenMatchesReference: digestMatches(comparison.refreshToken, comparison.references.refreshTokenSha256),
      outgoingRefreshTokenMatchesReference: requestRefreshTokens.length === 1 && digestMatches(requestRefreshTokens[0], comparison.references.refreshTokenSha256),
    };
  }
  let response: Response;
  try {
    response = await fetch(url, { ...init, body: requestBody, cache: "no-store", signal: AbortSignal.timeout(20000) });
  } catch {
    // Native fetch errors may include request URLs. Never propagate their text/cause.
    throw new Error(`Mailbox ${stage} failed (network).`);
  }
  if (!response.ok) {
    let codes: string[] = [];
    let body: unknown;
    let jsonParsed = false;
    try { body = await response.json(); jsonParsed = true; codes = safeProviderCodes(body, stage); } catch { /* Never expose parse errors or response text. */ }
    let shape = "";
    if (stage === "OAuth token exchange") {
      const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const contentType = !mime ? "missing" : ["application/json", "text/html", "text/plain"].includes(mime) ? mime : "other";
      const hasField = (key: string) => Boolean(body && typeof body === "object" && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, key));
      const errorValue = hasField("error") ? (body as Json).error : undefined;
      const errorType = !hasField("error") ? "missing" : errorValue === null ? "null" : Array.isArray(errorValue) ? "array" : typeof errorValue;
      // Only fixed keys, booleans and allowlisted MIME labels; never header/body values or URLs.
      shape = ` Response shape: ${JSON.stringify({ contentType, jsonParsed, errorPresent: hasField("error"), errorType, errorDescriptionPresent: hasField("error_description"), errorUriPresent: hasField("error_uri"), codeRecognized: codes.length > 0, redirected: response.redirected === true, ...clientIdCheck, ...(gmailTokenRequest && errorValue === "unauthorized_client" ? { unauthorizedClientDescriptionReason: safeUnauthorizedClientReason(body as Json) } : {}), ...(gmailTokenRequest && errorValue === "invalid_client" ? { clientDescriptionReason: safeClientReason(body as Json), ...clientSecretShape } : {}), ...(gmailTokenRequest && errorValue === "invalid_grant" ? { ...safeGrantReasons(body as Json), ...tokenShape } : {}) })}.`;
    }
    throw new Error(`Mailbox ${stage} failed (${response.status}${codes.length ? `; ${codes.join(", ")}` : ""}).${shape}`);
  }
  try {
    if (stage === "Gmail PDF attachment") {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing attachment body');
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const {done,value} = await reader.read(); if (done) break;
        size += value.length;
        if (size > 14 * 1024 * 1024) { await reader.cancel(); throw new Error('Attachment limit'); }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
    }
    return await response.json() as Json;
  }
  catch { throw new Error(`Mailbox ${stage} returned invalid JSON.`); }
}

async function tokenExchange(provider: EmailProvider, references?: MailboxDigestReferences): Promise<Json> {
  const microsoft = provider === "microsoft365";
  const clientId = process.env[microsoft ? "CMPRI_MS_CLIENT_ID" : "CMPRI_GMAIL_CLIENT_ID"];
  const clientSecret = process.env[microsoft ? "CMPRI_MS_CLIENT_SECRET" : "CMPRI_GMAIL_CLIENT_SECRET"];
  const tenant = process.env.CMPRI_MS_TENANT_ID;
  const refreshToken = process.env.CMPRI_GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || (microsoft ? !tenant || !process.env.CMPRI_MS_MAILBOX : !refreshToken || !process.env.CMPRI_GMAIL_ADDRESS)) {
    throw new Error(`${microsoft ? "Microsoft 365" : "Gmail"} mailbox configuration is incomplete.`);
  }
  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: microsoft ? "client_credentials" : "refresh_token" });
  if (microsoft) form.set("scope", "https://graph.microsoft.com/.default");
  else form.set("refresh_token", refreshToken!);
  return jsonRequest(microsoft ? `https://login.microsoftonline.com/${encodeURIComponent(tenant!)}/oauth2/v2.0/token` : "https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
  }, "OAuth token exchange", references ? { references, clientSecret, refreshToken: refreshToken! } : undefined);
}

export async function compareGmailCredentialDigests(references: MailboxDigestReferences) {
  if (!references || !/^[a-f0-9]{64}$/.test(references.clientSecretSha256) || !/^[a-f0-9]{64}$/.test(references.refreshTokenSha256)) throw new Error("Invalid comparison references.");
  return tokenExchange("gmail", references);
}

async function accessToken(provider: EmailProvider) {
  const data = await tokenExchange(provider);
  if (typeof data.access_token !== "string") throw new Error("Mailbox token response contained no access token.");
  return data.access_token;
}

export async function fetchOperationalMessages(options: { scope?: "po-label" | "po-history"; pageToken?: string; withPdfAttachments?: boolean; messageIds?: string[] } = {}) {
  const provider = configuredEmailProvider();
  if (!provider) return { provider, messages: [] as OperationalMessage[], truncated: false };
  if (options.scope && provider !== "gmail") throw new Error("PO label review requires the existing work Gmail provider.");
  if (options.messageIds && (options.messageIds.length > 100 || options.messageIds.some(id => !/^[A-Za-z0-9_+=/-]{1,1024}$/.test(id)))) throw new Error("Invalid message identities.");
  const token = await accessToken(provider);
  const headers = { authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"' };
  const messages: OperationalMessage[] = [];
  const messageLimit=options.withPdfAttachments?25:MAX_MESSAGES;
  let truncated = false;
  let continuation: string | undefined;
  if (provider === "gmail") {
    const base = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(process.env.CMPRI_GMAIL_USER || "me")}`;
    // Include ordinary replies and sent messages so established vendor threads remain visible.
    const query = options.scope === 'po-history' ? 'in:anywhere' : options.scope === "po-label" ? 'label:"POs"' : process.env.CMPRI_GMAIL_QUERY || "newer_than:14d";
    let pageToken = options.scope==='po-history'?options.pageToken||"":"";
    do {
      const params = new URLSearchParams({ q: query, maxResults: String(Math.min(100,messageLimit)) });
      if (pageToken) params.set("pageToken", pageToken);
      if(options.scope==='po-history')params.set("includeSpamTrash","true");
      const list = options.messageIds ? {messages: options.messageIds.map(id => ({id}))} : await jsonRequest(`${base}/messages?${params}`, { headers }, "Gmail list");
      for (const item of (list.messages || []) as { id: string }[]) {
        if (messages.length >= messageLimit) { truncated = true; break; }
        let row: Json;
        try { row = await jsonRequest(`${base}/messages/${encodeURIComponent(item.id)}?format=full`, { headers }, "Gmail retrieval"); }
        catch (error) { if (options.messageIds && error instanceof Error && /failed \(404(?:;|\))/.test(error.message)) continue; throw error; }
        const payload = row.payload as MimePart & { headers?: { name: string; value: string }[] };
        const header = (name: string) => payload?.headers?.find(entry => entry.name.toLowerCase() === name.toLowerCase())?.value || "";
        const from = header("from");
        const pdfEvidence=options.withPdfAttachments?await (await import("../po-attachment-intake")).inspectGmailPdfs(payload,async id=>{if(!id||id.length>4096)throw Error('Invalid attachment identity');const result=await jsonRequest(base+'/messages/'+encodeURIComponent(item.id)+'/attachments/'+encodeURIComponent(id),{headers,redirect:'error',signal:AbortSignal.timeout(20000)},'Gmail PDF attachment');if(typeof result.data!=='string'||result.data.length>14*1024*1024)throw Error('PDF exceeds limit');return new Uint8Array(Buffer.from(result.data,'base64url'));},{from,subject:header('subject')}):undefined;
        messages.push({ id: item.id, threadId: String(row.threadId || item.id), subject: header("subject"), from, to: header("to"), text: gmailText(payload), ...(pdfEvidence?{pdfEvidence}:{}), ...(options?.scope?{html:gmailHtml(payload),labelIds:Array.isArray(row.labelIds)?row.labelIds as string[]:[]}:{}), messageAt: new Date(Number(row.internalDate)).toISOString(), direction: messageDirection(from, process.env.CMPRI_GMAIL_ADDRESS || "") });
      }
      pageToken = String(list.nextPageToken || "");
      if (pageToken && messages.length >= messageLimit) truncated = true;
    } while (pageToken && !truncated);
    if(options.scope==='po-history')continuation=pageToken||undefined;
  } else {
    const mailbox = process.env.CMPRI_MS_MAILBOX!;
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    const params = new URLSearchParams({ "$top": "100", "$select": "id,conversationId,subject,receivedDateTime,from,toRecipients,body", "$orderby": "receivedDateTime desc", "$filter": `receivedDateTime ge ${since}` });
    let next = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages?${params}`;
    do {
      // Never forward mailbox bearer credentials to a provider-supplied foreign host.
      const nextUrl = new URL(next);
      if (nextUrl.origin !== "https://graph.microsoft.com" || !nextUrl.pathname.startsWith("/v1.0/")) throw new Error("Untrusted Microsoft pagination URL.");
      const targeted: Json[] = [];
      if (options.messageIds) for (const id of options.messageIds) {
        try { targeted.push(await jsonRequest(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(id)}?$select=id,conversationId,subject,receivedDateTime,from,toRecipients,body`, {headers}, "Microsoft messages")); }
        catch (error) { if (error instanceof Error && /failed \(404(?:;|\))/.test(error.message)) continue; throw error; }
      }
      const page = options.messageIds ? {value: targeted} : await jsonRequest(next, { headers }, "Microsoft messages");
      for (const row of (page.value || []) as Json[]) {
        if (messages.length >= messageLimit) { truncated = true; break; }
        const sender = row.from as { emailAddress?: { name?: string; address?: string } };
        const from = sender?.emailAddress?.address || "";
        const body = row.body as { content?: string; contentType?: string };
        const recipients = row.toRecipients as { emailAddress?: { address?: string } }[] | undefined;
        messages.push({ id: `microsoft365:${row.id}`, threadId: `microsoft365:${row.conversationId || row.id}`, subject: String(row.subject || ""), from, to: (recipients || []).map(item => item.emailAddress?.address || "").join(", "), text: body?.contentType?.toLowerCase() === "html" ? htmlToText(body.content || "") : body?.content || "", messageAt: new Date(String(row.receivedDateTime)).toISOString(), direction: messageDirection(from, mailbox) });
      }
      next = String(page["@odata.nextLink"] || "");
      if (next && messages.length >= messageLimit) truncated = true;
    } while (next && !truncated);
  }
  // Chronological ingestion prevents old updates replacing newer state and discovers outbound threads first.
  messages.sort((a, b) => a.messageAt.localeCompare(b.messageAt));
  return { provider, messages, truncated, nextPageToken:continuation };
}

/** Only provider-owned fixed endpoints are callable by push setup/history. No message writes. */
export async function mailboxPushRequest(provider: EmailProvider, operation: "watch" | "history" | "subscription", input: { id?: string; query?: URLSearchParams; body?: Record<string, unknown> } = {}) {
  if (configuredEmailProvider() !== provider) throw new Error("Mailbox provider changed.");
  const token = await accessToken(provider);
  let url: string, method = "GET";
  if (provider === "gmail" && operation !== "subscription") {
    url = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(process.env.CMPRI_GMAIL_USER || "me")}/${operation}`;
    if (operation === "watch") method = "POST";
    else if (input.query) url += `?${input.query}`;
  } else if (provider === "microsoft365" && operation === "subscription") {
    if (input.id && !/^[a-f0-9-]{36}$/i.test(input.id)) throw new Error("Invalid subscription identity.");
    url = "https://graph.microsoft.com/v1.0/subscriptions" + (input.id ? `/${input.id}` : "");
    method = input.id ? "PATCH" : "POST";
  } else throw new Error("Invalid push operation.");
  return jsonRequest(url, {method, headers:{authorization:`Bearer ${token}`, "Content-Type":"application/json",Prefer:'IdType="ImmutableId"'}, ...(input.body?{body:JSON.stringify(input.body)}:{}),redirect:"error",signal:AbortSignal.timeout(20000)},provider === "gmail" ? "Gmail retrieval" : "Microsoft messages");
}
