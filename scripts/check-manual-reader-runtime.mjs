// Check the real compiled reader as well as the separate isolated PDF.js probe.
// A direct library import cannot detect damage to application package lookups.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error('Compiled reader check attempted a network request'); };
try {
  require(path.resolve('.next/server/app/api/maintenance-reference/route.js'));
  const runtime = require(path.resolve('.next/server/webpack-runtime.js'));
  let inspectionModule;
  for (const file of readdirSync('.next/server/chunks').filter(file => file.endsWith('.js'))) {
    const chunk = require(path.resolve('.next/server/chunks', file));
    if (!chunk.modules) continue;
    // Webpack minifies export names. Find the implementation using its
    // page-label API and page-budget diagnostic, then execute its exports.
    for (const [id, factory] of Object.entries(chunk.modules)) {
      const code = factory.toString();
      if (code.includes('getPageLabels') && code.includes('Text indexing paused at PDF page')) inspectionModule = id;
    }
    runtime.C(chunk);
  }
  assert(inspectionModule, 'Compiled manual inspection module is missing');
  const inspect = Object.values(runtime(inspectionModule)).find(value => typeof value === 'function' && value.toString().includes('getPageLabels'));
  const preview = Object.values(runtime(inspectionModule)).find(value => typeof value === 'function' && value.toString().includes('Invalid PDF preview size.'));
  assert(inspect, 'Compiled manual inspection function is missing');
  assert(preview, 'Compiled upload preview function is missing');
  const originals = process.argv.length > 2 ? process.argv.slice(2) : ['public/guides/dormakaba.pdf'];
  for (const file of originals) {
    const bytes = new Uint8Array(readFileSync(file));
    const original = bytes.slice();
    const result = await inspect(bytes, { includeEmptyPages: true });
    assert(result.total_pages > 0 && result.text.trim().length > 0, 'Compiled reader did not extract the original PDF');
    assert.deepEqual(bytes, original, 'Compiled reader changed the original PDF');
    const sample=await preview(bytes,{previewPages:3});
    assert(sample.trim().length>0&&!sample.includes('PAGE 4\n'),'Upload preview must remain bounded');
    console.log(JSON.stringify({ compiledReader: true, pages: result.total_pages, characters: result.text.length }));
  }
} finally {
  globalThis.fetch = originalFetch;
}
