import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const document = loadTs("src/lib/server/ask-cmpri-public-document.ts", { "server-only": {} }, { URL, AbortSignal });
const source = (url, title = "Equipment manual") => ({ sourceType: "url", url, title });
const direct = "https://docs.vendorco.com/manuals/PZE09.pdf?revision=2";
const redirected = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/fixture";

function fixture(settings = {}) {
  const calls = [], requests = [], models = [];
  const search = loadTs("src/lib/server/ask-cmpri-public-search.ts", {
    "server-only": {},
    "./ask-cmpri-gemini": { askGeminiKey: () => settings.key === undefined ? "fixture-key" : settings.key },
    "./ask-cmpri-public-document": document,
    "@ai-sdk/google": { createGoogleGenerativeAI: ({ apiKey }) => {
      assert.equal(apiKey, "fixture-key");
      return Object.assign(name => { models.push(name); return name; }, { tools: { googleSearch: () => "fixture-grounding-tool" } });
    } },
    ai: { generateText: async options => {
      calls.push(options);
      if (settings.error) throw settings.error;
      return settings.result || { sources: [source(direct)] };
    } },
  }, {
    URL, AbortSignal, process: { env: { CMPRI_GEMINI_MODEL: "fixture-model" } },
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return settings.fetch ? settings.fetch(url, options) : new Response(null, { status: 302, headers: { location: direct } });
    },
  });
  return { search: (input, signal = new AbortController().signal) => search.searchAskVendorDocuments(input, signal), calls, requests, models };
}

test("generic native manufacturers and full model identifiers use only the public identity in the search query", async () => {
  const f = fixture();
  for (const [manufacturer, model] of [["Friedrich", "PZE09K3SB"], ["UniMac", "UW 65/S"], ["Dormakaba", "790"], ["Unlisted Maker & Co.", "123456789012345678901234567890123456789"]]) {
    const items = await f.search({ manufacturer, model, question: "Guest Jane room 212", serial: "PRIVATE-SERIAL", notes: "Private property note", location: "Pool", guest: { name: "Jane" } });
    const call = f.calls.at(-1);
    assert.equal(call.prompt, `${manufacturer} ${model} official manufacturer owner or service manual PDF`);
    assert.doesNotMatch(JSON.stringify(call), /Guest Jane|PRIVATE-SERIAL|Private property note|Pool/);
    assert.deepEqual(Object.keys(call.tools), ["google_search"]);
    assert.equal(items[0].href, direct);
  }
  assert.deepEqual(f.models, Array(4).fill("fixture-model"));
  assert.equal(f.requests.length, 0, "Ordinary search links are not fetched before the document transport validates DNS");
});

test("only actual URL sources and text supported by that source become results; generated links never do", async () => {
  const other = "https://vendorco.com/support/PZE09";
  const fabricated = "https://vendorco.com/invented.pdf";
  const f = fixture({ result: {
    text: `Use this made-up file: ${fabricated}`,
    sources: [source(direct), source(direct + "#page=3"), source(other, "Product support"), { sourceType: "document", id: "document", title: "Not a URL" }],
    providerMetadata: { google: { groundingMetadata: {
      groundingChunks: [{ web: { uri: direct } }, { web: { uri: fabricated } }],
      groundingSupports: [
        { groundingChunkIndices: [0], segment: { text: "The cited source provides the PZE09 manual." } },
        { groundingChunkIndices: [1], segment: { text: "This unsupported claim must not be shown." } },
      ],
    } } },
  } });
  const items = await f.search({ manufacturer: "Friedrich", model: "PZE09" });
  assert.deepEqual(Array.from(items, item => item.href), [direct, other]);
  assert.equal(items[0].text, "The cited source provides the PZE09 manual.");
  assert.equal(items[1].text, undefined);
  assert.doesNotMatch(JSON.stringify(items), /invented|unsupported claim|made-up/);
  assert.match(items[0].source, /docs\.vendorco\.com via Google Search/);
  assert.notEqual(items[0].id, items[1].id);
});

test("public URL validation rejects credentials, local addresses and non-HTTPS sources", async () => {
  const unsafe = ["http://vendorco.com/manual.pdf", "https://user:secret@vendorco.com/manual.pdf", "https://localhost/manual.pdf", "https://127.0.0.1/manual.pdf", "https://metadata.google.internal/manual.pdf", "file:///etc/passwd", "https://vendorco.com/manual.pdf?api_key=private", "https://vendorco.com:8443/manual.pdf"];
  const f = fixture({ result: { sources: [...unsafe.map(url => source(url)), source(direct)] } });
  const items = await f.search({ manufacturer: "UniMac", model: "UW65" });
  assert.deepEqual(Array.from(items, item => item.href), [direct]);
  assert.equal(f.requests.length, 0);
});

test("a grounding redirect resolves only the known Google endpoint without forwarding credentials or following the vendor URL", async () => {
  const f = fixture({ result: { sources: [source(redirected)], providerMetadata: { google: {
    groundingMetadataPerRequest: [{ groundingChunks: [{ web: { uri: redirected } }], groundingSupports: [{ supportChunkIndices: [0], segment_text: "Original manufacturer document." }] }],
  } } } });
  const items = await f.search({ manufacturer: "Friedrich", model: "PZE09" });
  assert.equal(items[0].href, direct);
  assert.equal(items[0].text, "Original manufacturer document.");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, redirected);
  assert.equal(f.requests[0].options.method, "HEAD");
  assert.equal(f.requests[0].options.redirect, "manual");
  assert.equal(f.requests[0].options.credentials, "omit");
  assert.equal(f.requests[0].options.headers, undefined);
  for (const location of ["https://127.0.0.1/private.pdf", "http://vendorco.com/manual.pdf", "https://user:secret@vendorco.com/manual.pdf"]) {
    const rejected = fixture({ result: { sources: [source(redirected)] }, fetch: () => new Response(null, { status: 302, headers: { location } }) });
    assert.equal((await rejected.search({ manufacturer: "Friedrich", model: "PZE09" })).length, 0);
    assert.equal(rejected.requests.length, 1);
  }
});

test("vendor domains restrict results to the exact host or its subdomains after redirect resolution", async () => {
  const f = fixture({ result: { sources: [source("https://vendorco.com/manual.pdf"), source(direct), source("https://evilvendorco.com/manual.pdf"), source("https://vendorco.com.evil.com/manual.pdf"), source(redirected)] } });
  const items = await f.search({ manufacturer: "Dormakaba", model: "790", vendorDomain: "https://vendorco.com/support" });
  assert.deepEqual(Array.from(items, item => item.href), ["https://vendorco.com/manual.pdf", direct]);
  assert.equal(f.calls[0].prompt, "Dormakaba 790 official manufacturer owner or service manual PDF site:vendorco.com");
  await assert.rejects(f.search({ manufacturer: "Dormakaba", model: "790", vendorDomain: "localhost" }), /public HTTPS/);
  assert.equal(f.calls.length, 1);
});

test("no sources produce no fallback links, while provider errors and cancellation remain errors", async () => {
  const empty = fixture({ result: { text: "https://vendorco.com/invented.pdf", sources: [] } });
  assert.equal((await empty.search({ manufacturer: "Whirlpool", model: "WFW5620HW" })).length, 0);
  const failed = fixture({ error: Error("Search provider failed") });
  await assert.rejects(failed.search({ manufacturer: "UniMac", model: "UW65" }), /Search provider failed/);
  const cancelled = fixture();
  const controller = new AbortController(); controller.abort(Error("Cancelled"));
  await assert.rejects(cancelled.search({ manufacturer: "UniMac", model: "UW65" }, controller.signal), /Cancelled/);
  assert.equal(cancelled.calls.length, 0);
  const missingKey = fixture({ key: null });
  await assert.rejects(missingKey.search({ manufacturer: "UniMac", model: "UW65" }), /not configured/);
  assert.equal(missingKey.calls.length, 0);
});
