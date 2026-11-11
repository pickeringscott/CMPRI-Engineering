import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { loadTs } from './helpers/load-ts.mjs';
import { isUuid } from '../src/lib/uuid.ts';
const hotel = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6', assetId = '00000000-0000-4000-8000-000000000011', actor = '00000000-0000-4000-8000-000000000012';
const bytes = new Uint8Array(Buffer.from('%PDF-source')), hash = createHash('sha256').update(bytes).digest('hex');
function fixture(options = {}) {
  const sourceBytes = options.bytes || bytes, sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const file = { id: 'registered-file', storage_path: `${hotel}/${assetId}/original.pdf`, name: 'original.pdf', preferred: false, created_at: null, updated_at: '2026-01-01' };
  const state = { rows: new Map(), files: [file], downloads: 0, reads: 0, writes: 0, asset: { id: assetId, hotel_id: hotel, active: true } };
  const admin = { storage: { from(bucket) { assert.equal(bucket, 'asset-documentation'); return { async download(path) { assert.equal(path, file.storage_path); state.downloads++; return { data: new Blob([options.byteRace && state.downloads > 1 ? '%PDF-changed' : sourceBytes]) }; } }; } }, from(table) {
    if (table === 'assets') { const q = { select() { return q; }, eq() { return q; }, async maybeSingle() { return { data: state.asset }; } }; return q; }
    assert.equal(table, 'troubleshooting_cache'); const filters = [];
    const q = { select() { return q; }, eq(k,v) { filters.push([k,v]); return q; }, like(k,v) { filters.push([k,v]); return q; }, async limit(n) { assert.equal(n,600); state.reads++; return { error: options.readError, data: options.dropRead ? [] : [...state.rows.values()].filter(row => filters.every(([k,v]) => k === 'cache_key' ? row[k].startsWith(v.slice(0,-1)) : row[k] === v)) }; }, async upsert(rows, config) {
      assert.equal(config.onConflict, 'hotel_id,cache_type,cache_key'); state.writes++;
      if (options.writeError) return { error: 'failed' };
      for (const row of rows) state.rows.set(row.cache_key, row);
      if (options.unlinkAfterWrite) state.files = [];
      if (options.assetRace) state.asset = { ...state.asset, model_number: 'changed' };
      return {};
    } }; return q;
  } };
  const mod = loadTs('src/lib/server/reviewed-manual-text.ts', {
    'node:crypto': { createHash }, '@/lib/constants': { HOTEL_ID: hotel }, '@/lib/uuid': { isUuid },
    '@/lib/server/asset-file-register': { listRegisteredAssetFiles: async () => ({ data: state.files }) },
    '@/lib/server/manual-ocr': { manualOcrPageCount: options.pageCount || (async () => options.actualPages || 3) },
  }, { Uint8Array });
  const input = { assetId, sha256: sourceHash, totalPages: options.totalPages || 3, reviewConfirmed: true, pages: [{ page: 1, text: 'Reviewed instruction <script>alert(1)</script>' }] };
  const source = { hotelId: hotel, assetId, sha256: sourceHash, file };
  return { state, admin, mod, input, source };
}
test('save -> read preserves plain text, per-page batches, source count, and original PDF', async () => {
  const h=fixture(); await h.mod.saveReviewedManualPages(h.admin,actor,h.input);
  await h.mod.saveReviewedManualPages(h.admin,actor,{...h.input,pages:[{page:2,text:'Second page'}]});
  const pages=await h.mod.readReviewedManualPages(h.admin,h.source);
  assert.equal(pages.length,2); assert.equal(pages[0].text,h.input.pages[0].text); assert.equal(pages[0].totalPages,3);
  assert.equal(h.state.rows.size,2); assert.ok([...h.state.rows.values()].every(row=>row.expires_at===null && row.payload.reviewed_by===actor));
});
test('rejects invalid confirmation, identity, count, empty/large/duplicate/out-of-range batches before writes', async()=>{
  for(const patch of [{reviewConfirmed:false},{assetId:'bad'},{sha256:'bad'},{totalPages:601},{pages:[]},{pages:[{page:0,text:'x'}]},{pages:[{page:4,text:'x'}]},{pages:[{page:1,text:' '}]},{pages:[{page:1,text:'x'.repeat(50001)}]},{pages:[{page:1,text:'a'},{page:1,text:'b'}]},{pages:Array.from({length:11},(_,i)=>({page:i+1,text:'x'})),totalPages:11}]) {
    const h=fixture(); await assert.rejects(h.mod.saveReviewedManualPages(h.admin,actor,{...h.input,...patch})); assert.equal(h.state.writes,0);
  }
});
test('rejects mismatched originals and page counts, inactive/missing assets, and absent attachments',async()=>{
  for(const options of [{actualPages:2},{byteRace:true}]) {const h=fixture(options);await assert.rejects(h.mod.saveReviewedManualPages(h.admin,actor,h.input));assert.equal(h.state.writes,0);}
  const h=fixture();await assert.rejects(h.mod.saveReviewedManualPages(h.admin,actor,{...h.input,sha256:'a'.repeat(64)}),/does not match/);
  h.state.files=[];await assert.rejects(h.mod.saveReviewedManualPages(h.admin,actor,h.input),/not attached/);
  for(const asset of [null,{id:assetId,hotel_id:hotel,active:false},{id:assetId,hotel_id:'other',active:true}]) {h.state.asset=asset;await assert.rejects(h.mod.saveReviewedManualPages(h.admin,actor,h.input),/unavailable/);}
});
test('ambiguous PDFs require unique preferred PDF; never silently choose a different attachment',async()=>{
  const h=fixture();h.state.files.push({...h.source.file,id:'other',name:'second.pdf'});
  await assert.rejects(h.mod.saveReviewedManualPages(h.admin,actor,h.input),/preferred PDF/);
  h.state.files[0].preferred=true;await h.mod.saveReviewedManualPages(h.admin,actor,h.input);
  h.state.files[1].preferred=true;await assert.rejects(h.mod.saveReviewedManualPages(h.admin,actor,h.input),/More than one/);
  h.state.files[1].preferred=false;h.state.files[0].name='manual.html';await assert.rejects(h.mod.saveReviewedManualPages(h.admin,actor,h.input),/not a PDF/);
});
test('stale, unlinked, generic, different asset/hash, corrupt payloads are never read as reviewed pages',async()=>{
  const h=fixture();await h.mod.saveReviewedManualPages(h.admin,actor,h.input);
  assert.equal((await h.mod.readReviewedManualPages(h.admin,{...h.source,sha256:'a'.repeat(64)})).length,0);
  const row=[...h.state.rows.values()][0];row.payload.asset_id='other';assert.equal((await h.mod.readReviewedManualPages(h.admin,h.source)).length,0);row.payload.asset_id=assetId;
  row.payload.page=9;assert.equal((await h.mod.readReviewedManualPages(h.admin,h.source)).length,0);row.payload.page=1;
  h.state.rows.set('upload-legacy',{...row,cache_key:'upload-legacy'});
  h.state.files=[{...h.source.file,updated_at:'replacement'}];assert.equal((await h.mod.readReviewedManualPages(h.admin,h.source)).length,0);
  h.state.files=[];assert.equal((await h.mod.readReviewedManualPages(h.admin,h.source)).length,0);
});
test('save cannot report success after races, persistence failure, or failed exact readback',async()=>{
  for(const options of [{unlinkAfterWrite:true},{assetRace:true},{writeError:true},{dropRead:true},{readError:true}]) {
    const h=fixture(options);await assert.rejects(h.mod.saveReviewedManualPages(h.admin,actor,h.input));
  }
});
function routeFixture(auth, options={}) {
  const h=fixture(options);let saves=0;
  const route=loadTs('src/app/api/assets/documentation/reviewed-text/route.ts',{
    'next/server':{NextResponse:{json:(data,init)=>({data,status:init?.status||200})}},'@/lib/constants':{HOTEL_ID:hotel},
    '@/lib/server/auth':{requireUser:async()=>auth===null?null:{admin:h.admin,principal:{hotelId:hotel,profile:{role:'engineer'},identity:{id:actor},...auth}}},
    '@/lib/server/access':{allows:p=>p.allowed!==false},'@/lib/server/roles':{canEditEquipment:role=>role==='engineer'},
    '@/lib/server/reviewed-manual-text':{...h.mod,saveReviewedManualPages:async(...args)=>{saves++;return h.mod.saveReviewedManualPages(...args);}},
  },{TextDecoder,Uint8Array});
  return {...h,route,get saves(){return saves;}};
}
const request=(body,headers={})=>new Request('https://example.test/api/assets/documentation/reviewed-text',{method:'POST',headers:{'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
test('route requires auth, current property, manage_assets, and equipment editor role',async()=>{
  for(const [auth,status] of [[null,401],[{hotelId:'other'},403],[{allowed:false},403],[{profile:{role:'technician'}},403]]) {
    const h=routeFixture(auth);assert.equal((await h.route.POST(request(h.input))).status,status);assert.equal(h.saves,0);
  }
  const h=routeFixture({});assert.equal((await h.route.POST(request(h.input))).data.saved,true);
});
test('route bounds actual streamed JSON, rejects malformed JSON and non-JSON',async()=>{
  const h=routeFixture({});
  assert.equal((await h.route.POST(request('x'.repeat(2*1024*1024+1)))).status,413);
  assert.equal((await h.route.POST(request('{}',{'content-length':String(2*1024*1024+1)}))).status,413);
  assert.equal((await h.route.POST(request('{bad'))).status,400);
  assert.equal((await h.route.POST(request('{}',{'content-type':'text/plain'}))).status,415);
  assert.equal(h.saves,0);
});

// A real text-free PDF: metadata must suffice even when no native text exists.
function blankPdf(count=2) {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({length:count},(_,i)=>`${i+3} 0 R`).join(' ')}] /Count ${count} >>`, ...Array.from({length:count},()=> '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>')];
  let pdf='%PDF-1.4\n';const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}
test('real blank PDF metadata verifies source count without native text; malformed PDF rejected',async()=>{
  const require=createRequire(import.meta.url);
  const real=loadTs('src/lib/server/manual-ocr.ts',{'node:module':{createRequire},'node:path':{default:path},'@napi-rs/canvas':{createCanvas},'pdfjs-dist/legacy/build/pdf.mjs':require('pdfjs-dist/legacy/build/pdf.mjs')},{Buffer,Uint8Array});
  const h=fixture({bytes:blankPdf(),totalPages:2,pageCount:real.manualOcrPageCount});
  const result=await h.mod.saveReviewedManualPages(h.admin,actor,h.input);assert.equal(result.saved,true);
  assert.equal((await h.mod.readReviewedManualPages(h.admin,h.source))[0].totalPages,2);
  await assert.rejects(h.mod.saveReviewedManualPages(h.admin,actor,{...h.input,totalPages:3}),/page count does not match/);
  const bad=fixture({pageCount:real.manualOcrPageCount});await assert.rejects(bad.mod.saveReviewedManualPages(bad.admin,actor,bad.input),/page count could not be verified/);assert.equal(bad.state.writes,0);
});
test('simultaneous different-page batches retain all saved pages',async()=>{
  const h=fixture();await Promise.all([1,2,3].map(page=>h.mod.saveReviewedManualPages(h.admin,actor,{...h.input,pages:[{page,text:`Reviewed ${page}`}]})));
  assert.equal(h.state.rows.size,3);assert.equal((await h.mod.readReviewedManualPages(h.admin,h.source)).length,3);
});
test('reader rejects property/asset/file identity mismatches and readback text tampering',async()=>{
  const h=fixture();await h.mod.saveReviewedManualPages(h.admin,actor,h.input);
  for(const change of [{hotelId:'other'},{assetId:actor},{file:{...h.source.file,id:'other'}},{file:{...h.source.file,storage_path:'other'}},{totalPages:2}]) assert.equal((await h.mod.readReviewedManualPages(h.admin,{...h.source,...change})).length,0);
  const row=[...h.state.rows.values()][0];row.payload.reviewed_by='invalid';assert.equal((await h.mod.readReviewedManualPages(h.admin,h.source)).length,0);
});
