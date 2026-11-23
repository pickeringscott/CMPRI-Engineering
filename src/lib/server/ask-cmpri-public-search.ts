import "server-only";
import { createHash } from "node:crypto";
import { createGoogleGenerativeAI, type GoogleProviderMetadata } from "@ai-sdk/google";
import { generateText } from "ai";
import type { AskResultItem } from "@/lib/ask-cmpri/types";
import { askGeminiKey } from "./ask-cmpri-gemini";
import { askPublicDocumentUrl } from "./ask-cmpri-public-document";

function publicIdentity(value: string, label: string): string {
  const identity = value.trim();
  if (!identity || identity.length > 200 || /[\u0000-\u001f\u007f]/.test(identity)) {
    throw new Error(`The native equipment ${label} is required for the document search.`);
  }
  return identity;
}

async function sourceUrl(value: string, signal: AbortSignal): Promise<URL> {
  let url = askPublicDocumentUrl(value);
  // Only Google's known grounding endpoint is fetched here, without following any redirect.
  // The document reader validates and pins public DNS before fetching the returned vendor URL.
  for (let hop = 0; url.hostname === "vertexaisearch.cloud.google.com" && url.pathname.startsWith("/grounding-api-redirect/"); hop++) {
    if (hop >= 2) throw new Error("The search source redirected too many times.");
    const response = await fetch(url, {
      method: "HEAD", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer",
      signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
    });
    const target = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !target) throw new Error("The search source could not be resolved.");
    url = askPublicDocumentUrl(new URL(target, url).href);
  }
  return url;
}

/** Callers derive this identity from a fresh authorized asset, never from a model's verification flag. */
export async function searchAskVendorDocuments(
  input: { manufacturer: string; model: string; vendorDomain?: string }, signal: AbortSignal,
): Promise<AskResultItem[]> {
  return searchAskEquipmentSources({ ...input, intent: "manual" }, signal);
}

/** The native search caller grounds these public fields before using this shared transport. */
export async function searchAskEquipmentSources(
  input: { manufacturer: string; model: string; intent: "manual" | "manufacturer" | "error-code"; errorCode?: string; vendorDomain?: string },
  signal: AbortSignal,
): Promise<AskResultItem[]> {
  signal.throwIfAborted();
  const manufacturer = publicIdentity(input.manufacturer, "manufacturer");
  const model = publicIdentity(input.model, "model");
  const suffix = input.intent === "manual" ? "official manufacturer owner or service manual PDF"
    : input.intent === "manufacturer" ? "official manufacturer specifications and support"
      : input.intent === "error-code" ? "official manufacturer error code " + publicIdentity(input.errorCode || "", "error code") : "";
  if (!suffix) throw new Error("Choose a manufacturer, manual or error-code search.");
  const vendorDomain = input.vendorDomain?.trim();
  const vendorHost = vendorDomain
    ? askPublicDocumentUrl(vendorDomain.includes("://") ? vendorDomain : "https://" + vendorDomain).hostname : undefined;
  const apiKey = askGeminiKey();
  if (!apiKey) throw new Error("CMPRI Gemini is not configured.");
  const google = createGoogleGenerativeAI({ apiKey });
  const result = await generateText({
    model: google(process.env.CMPRI_GEMINI_MODEL?.trim() || "gemini-3.5-flash"),
    abortSignal: signal, maxRetries: 0, maxOutputTokens: 1000,
    system: input.intent === "manual"
      ? "Find public equipment documents for exactly the supplied manufacturer and model. Prefer the manufacturer's official owner or service manual and original PDF; vendor document sources are also useful. Use only retrieved sources. Do not invent URLs, document contents, page numbers or installed-equipment applicability."
      : "Find public equipment information for exactly the supplied manufacturer, model and explicit error code when provided. Prefer the manufacturer's original specifications, support and diagnostic documents. Use only retrieved sources. Do not invent URLs, code meanings, document contents, page numbers or installed-equipment applicability.",
    // Deliberately construct the public query; no question, serial, location, notes or spread of input.
    prompt: `${manufacturer} ${model} ${suffix}${vendorHost ? " site:" + vendorHost : ""}`,
    tools: { google_search: google.tools.googleSearch({}) },
  });
  signal.throwIfAborted();
  const metadata = result.providerMetadata?.google as GoogleProviderMetadata | undefined;
  const groundings = [metadata?.groundingMetadata, ...(metadata?.groundingMetadataPerRequest || [])];
  const items = await Promise.all(result.sources.slice(0, 24).map(async (entry): Promise<AskResultItem | undefined> => {
    if (entry.sourceType !== "url") return undefined;
    try {
      const url = await sourceUrl(entry.url, signal);
      if (vendorHost && url.hostname !== vendorHost && !url.hostname.endsWith("." + vendorHost)) return undefined;
      const support = groundings.flatMap(grounding => {
        const indices = grounding?.groundingChunks?.flatMap((chunk, index) => chunk.web?.uri === entry.url ? [index] : []) || [];
        return grounding?.groundingSupports?.filter(part =>
          (part.groundingChunkIndices || part.supportChunkIndices || []).some(index => indices.includes(index)))
          .map(part => part.segment?.text || part.segment_text || "").filter(Boolean) || [];
      });
      const text = [...new Set(support)].join(" ").slice(0, 950);
      return {
        id: "vendor-document-" + createHash("sha256").update(url.href).digest("hex").slice(0, 20),
        title: entry.title?.slice(0, 180) || url.hostname, ...(text ? { text } : {}),
        source: "Web · " + url.hostname + " via Google Search", sourceType: "web",
        href: url.href, hrefLabel: "Open source",
      };
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  }));
  const unique = new Map<string, AskResultItem>();
  for (const item of items) {
    if (!item?.href) continue;
    const previous = unique.get(item.href);
    if (!previous) unique.set(item.href, item);
    else if (!previous.text && item.text) previous.text = item.text;
  }
  return [...unique.values()].slice(0, 10);
}
