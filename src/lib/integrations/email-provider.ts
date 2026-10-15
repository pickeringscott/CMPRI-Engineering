/** Read-only mailbox adapters. The only POST is an OAuth token exchange. */
export type EmailProvider = "gmail" | "microsoft365";
export type OperationalMessage = { id: string; threadId?: string; subject: string; from: string; to: string; text: string; messageAt: string; direction: "inbound" | "outbound" };
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

type MimePart = { mimeType?: string; body?: { data?: string }; parts?: MimePart[] };
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

type RequestStage = "OAuth token exchange" | "Gmail list" | "Gmail retrieval" | "Microsoft messages";
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
async function jsonRequest(url: string, init: RequestInit, stage: RequestStage): Promise<Json> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(20000) });
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
      shape = ` Response shape: ${JSON.stringify({ contentType, jsonParsed, errorPresent: hasField("error"), errorType, errorDescriptionPresent: hasField("error_description"), errorUriPresent: hasField("error_uri"), codeRecognized: codes.length > 0, redirected: response.redirected === true })}.`;
    }
    throw new Error(`Mailbox ${stage} failed (${response.status}${codes.length ? `; ${codes.join(", ")}` : ""}).${shape}`);
  }
  try { return await response.json() as Json; }
  catch { throw new Error(`Mailbox ${stage} returned invalid JSON.`); }
}

async function accessToken(provider: EmailProvider) {
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
  const data = await jsonRequest(microsoft ? `https://login.microsoftonline.com/${encodeURIComponent(tenant!)}/oauth2/v2.0/token` : "https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
  }, "OAuth token exchange");
  if (typeof data.access_token !== "string") throw new Error("Mailbox token response contained no access token.");
  return data.access_token;
}

export async function fetchOperationalMessages() {
  const provider = configuredEmailProvider();
  if (!provider) return { provider, messages: [] as OperationalMessage[], truncated: false };
  const token = await accessToken(provider);
  const headers = { authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"' };
  const messages: OperationalMessage[] = [];
  let truncated = false;
  if (provider === "gmail") {
    const base = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(process.env.CMPRI_GMAIL_USER || "me")}`;
    // Include ordinary replies and sent messages so established vendor threads remain visible.
    const query = process.env.CMPRI_GMAIL_QUERY || "newer_than:14d";
    let pageToken = "";
    do {
      const params = new URLSearchParams({ q: query, maxResults: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const list = await jsonRequest(`${base}/messages?${params}`, { headers }, "Gmail list");
      for (const item of (list.messages || []) as { id: string }[]) {
        if (messages.length >= MAX_MESSAGES) { truncated = true; break; }
        const row = await jsonRequest(`${base}/messages/${encodeURIComponent(item.id)}?format=full`, { headers }, "Gmail retrieval");
        const payload = row.payload as MimePart & { headers?: { name: string; value: string }[] };
        const header = (name: string) => payload?.headers?.find(entry => entry.name.toLowerCase() === name.toLowerCase())?.value || "";
        const from = header("from");
        messages.push({ id: item.id, threadId: String(row.threadId || item.id), subject: header("subject"), from, to: header("to"), text: gmailText(payload), messageAt: new Date(Number(row.internalDate)).toISOString(), direction: messageDirection(from, process.env.CMPRI_GMAIL_ADDRESS || "") });
      }
      pageToken = String(list.nextPageToken || "");
      if (pageToken && messages.length >= MAX_MESSAGES) truncated = true;
    } while (pageToken && !truncated);
  } else {
    const mailbox = process.env.CMPRI_MS_MAILBOX!;
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    const params = new URLSearchParams({ "$top": "100", "$select": "id,conversationId,subject,receivedDateTime,from,toRecipients,body", "$orderby": "receivedDateTime desc", "$filter": `receivedDateTime ge ${since}` });
    let next = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages?${params}`;
    do {
      // Never forward mailbox bearer credentials to a provider-supplied foreign host.
      const nextUrl = new URL(next);
      if (nextUrl.origin !== "https://graph.microsoft.com" || !nextUrl.pathname.startsWith("/v1.0/")) throw new Error("Untrusted Microsoft pagination URL.");
      const page = await jsonRequest(next, { headers }, "Microsoft messages");
      for (const row of (page.value || []) as Json[]) {
        if (messages.length >= MAX_MESSAGES) { truncated = true; break; }
        const sender = row.from as { emailAddress?: { name?: string; address?: string } };
        const from = sender?.emailAddress?.address || "";
        const body = row.body as { content?: string; contentType?: string };
        const recipients = row.toRecipients as { emailAddress?: { address?: string } }[] | undefined;
        messages.push({ id: `microsoft365:${row.id}`, threadId: `microsoft365:${row.conversationId || row.id}`, subject: String(row.subject || ""), from, to: (recipients || []).map(item => item.emailAddress?.address || "").join(", "), text: body?.contentType?.toLowerCase() === "html" ? htmlToText(body.content || "") : body?.content || "", messageAt: new Date(String(row.receivedDateTime)).toISOString(), direction: messageDirection(from, mailbox) });
      }
      next = String(page["@odata.nextLink"] || "");
      if (next && messages.length >= MAX_MESSAGES) truncated = true;
    } while (next && !truncated);
  }
  // Chronological ingestion prevents old updates replacing newer state and discovers outbound threads first.
  messages.sort((a, b) => a.messageAt.localeCompare(b.messageAt));
  return { provider, messages, truncated };
}
