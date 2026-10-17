import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { manualMatchesEquipment } from '../src/lib/manual-document-match.ts';

const asset = { id: 'temptrol-room', active: true, location_id: null, manufacturer: 'Symmons', model_family: 'Temptrol Shower Valve', model_number: null };
const reviewed = { manufacturer: 'Symmons', equipment: 'Temptrol Shower Valve', source: { verified: true, source_file_name: 'temptrol.pdf' }, error_codes:[{code:'4',problem:'Reviewed fault',action:'Reviewed diagnostic action',source_pages:[6]}], symptom_rules: [{ match: ['leak'], steps: ['Manual repair instruction'], source_pages: [4] }] };
function fixture(payload = reviewed, catalog = true, fileError = null) {
  const queries = [];
  const registerExports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/server/asset-file-register.ts", import.meta.url), "utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, {exports:registerExports});
  const admin = {
    rpc: async (name, args) => { assert.equal(name, "cmpri_list_asset_files"); assert.equal(args.p_asset_id, asset.id); return {data:[], error:fileError}; },
    from(table) {
      const filters = [];
      const q = { select: () => q, eq: (key, value) => { filters.push([key, value]); return q; }, order: () => q, range: () => q,
        maybeSingle: async () => { queries.push({ table, filters }); return { data: table === 'assets' ? asset : { payload }, error: null }; },
        then: (resolve) => resolve({ data: [], error: null }),
        upsert: () => { throw Error('GET must not write'); },
      };
      return q;
    },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), createSignedUrl: async () => ({ data: { signedUrl: 'https://example.invalid/verified.pdf' }, error: null }) }) },
  };
  const exports = {};
  const source = readFileSync(new URL('../src/app/api/maintenance-reference/route.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports,
    fetch: () => { throw Error('GET must not call AI'); },
    require(name) {
      if (name === '@/lib/server/pre-consolidation/maintenance-reference-route') return { GET: async () => null };
      if (name === '@/lib/server/consolidation-stage') return { dispatchConsolidation: async () => null };
      if (name === '@/lib/server/asset-file-register') return registerExports;
      if (name === 'next/server') return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status || 200 }) } };
      if (name === '@/lib/constants') return { HOTEL_ID: 'hotel' };
      if (name === '@/lib/server/auth') return { requireCapability: async () => ({ admin, principal: {} }) };
      if (name === '@/lib/server/access') return { allows: () => true };
      if (name === '@/lib/server/roles') return { roleAllows: () => false };
      if (name === '@/lib/manual-document-match') return { manualMatchesEquipment };
      if (name === '@/lib/manual-pdf-knowledge') return {};
      if (name === '@/lib/server/verified-manual-catalog') return { loadVerifiedCatalogManuals: async () => ({ documents: catalog ? [{ name: 'temptrol.pdf', storagePath: 'Asset Docs/temptrol.pdf', knowledgeKey: 'catalog-key', modelFamily: 'Temptrol', manufacturer: 'Symmons', sha256: 'verified-bytes', text: 'Verified PDF text', knowledge: payload }] : [], warnings: [] }) };
      throw Error(name);
    },
  });
  return { run: () => exports.GET({ nextUrl: new URL('https://example.invalid/api/maintenance-reference?assetId=temptrol-room') }), queries };
}
test('verified catalog-linked guidance keeps source pages without AI or database writes', async () => {
  const f = fixture(); const r = await f.run();
  assert.equal(r.status, 200); assert.equal(r.body.documentation_status, 'verified');
  assert.equal(r.body.manualKnowledge.symptom_rules[0].source_pages[0], 4);
  assert.equal(r.body.manualKnowledge.symptom_rules[0].source_url,'https://example.invalid/verified.pdf');
  assert.equal(r.body.manualKnowledge.error_codes[0].code,'4');
  assert.equal(r.body.manualKnowledge.error_codes[0].source_pages[0],6);
  assert.equal(r.body.manualKnowledge.error_codes[0].source_url,'https://example.invalid/verified.pdf');
  assert(!f.queries.some(q => q.table === 'troubleshooting_cache')); // Shared verified loader supplied the linked payload.
});
for (const [name, payload] of [
  ['missing knowledge', null],
  ['wrong manufacturer', { ...reviewed, manufacturer: 'Other' }],
  ['wrong family', { ...reviewed, equipment: 'Other' }],
  ['unverified source', { ...reviewed, source: { ...reviewed.source, verified: false } }],
  ['wrong PDF', { ...reviewed, source: { ...reviewed.source, source_file_name: 'other.pdf' } }],
]) test(`${name} does not become generic or generated guidance`, async () => {
  const r = await fixture(payload).run();
  assert.equal(r.body.manualKnowledge, null); assert.equal(r.body.documentation_status, 'no_guidance');
});
test('knowledge cannot bypass current PDF verification', async () => {
  const f = fixture(reviewed, false); const r = await f.run();
  assert.equal(r.body.manualKnowledge, null);
  assert(!f.queries.some(q => q.table === 'troubleshooting_cache'));
});

test("file-register errors fail closed without guidance", async()=>{const r=await fixture(reviewed,true,{message:"unavailable"}).run();assert.equal(r.status,503);assert.equal(r.body.manualKnowledge,undefined);});
