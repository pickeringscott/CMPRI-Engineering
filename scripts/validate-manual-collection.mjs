// Replay authorized snapshots locally. No downloads, AI calls, or live writes.
// CMPRI_MANUAL_SNAPSHOT_DIR points to the private audit snapshot, never committed here.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
const directory=process.env.CMPRI_MANUAL_SNAPSHOT_DIR;
if(!directory){console.log('Actual-manual validation requires CMPRI_MANUAL_SNAPSHOT_DIR; no fictional records are substituted.');process.exit(2);}
process.env.CMPRI_MANUAL_PREVIEW_READ_ONLY='1';
process.env.NEXT_PUBLIC_SUPABASE_URL||='https://uavotsoanubpowvyqaii.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||='offline-transport-only';
const root=path.resolve('.');
registerHooks({resolve(s,c,n){
  if(s==='server-only')return {url:'data:text/javascript,export{}',shortCircuit:true};
  if(s==='next/server')s='next/server.js';
  if(s.startsWith('@/'))s=new URL(`src/${s.slice(2)}.ts`,'file://'+root+'/').href;
  try{return n(s,c);}catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw error;}
}});
const {loadUploadedAssetGuide}=await import('../src/lib/server/uploaded-asset-guide.ts');
const {deriveTroubleshootingChecklistContext}=await import('../src/lib/work-orders/troubleshooting-checklist.ts');
const {normalizeManualKnowledge}=await import('../src/lib/manual-knowledge.ts');
const {inspectManualPdf}=await import('../src/lib/manual-pdf-knowledge.ts');
const {extractPdfManualStructure}=await import('../src/lib/server/pdf-troubleshooting-tables.ts');
const {resolveManualProcedureReferences}=await import('../src/lib/manual-procedure-references.ts');
const {structureManualDocument}=await import('../src/lib/manual-document-html.ts');
const {uploadedManualHtmlActions}=await import('../src/lib/uploaded-manual-actions.ts');
const {manualPreviewFetch}=await import('../src/lib/server/manual-preview.ts');
const {relevantSourcePassages}=await import('../src/lib/manual-source.ts');
const {technicianTroubleshootingContext}=await import('../src/lib/work-orders/technician-context.ts');
const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
const snapshot=read('actual-full-snapshot.json'),downloads=read('live-manual-downloads.json'),docs=read('live-manual-snapshot.json');
const tickets=read('audit2-tickets.json');
const hotel=snapshot.assets[0].hotel_id,files=new Map(snapshot.files.map(entry=>[entry.asset_id,entry.files||[]]));
const originals=new Map(downloads.filter(d=>d.file).map(d=>{const bytes=new Uint8Array(fs.readFileSync(d.file));assert.equal(createHash('sha256').update(bytes).digest('hex'),d.sha256);return [d.storage_path,bytes];}));
const links=new Map(docs.documents.flatMap(group=>group.documents||[]).map(d=>[d.storage_path,d.url]));
let writeAttempts=0,networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw Error('External requests are disabled during actual-record replay.');};
const admin={
  from(table){
    const all={assets:snapshot.assets,maintenance_documents:snapshot.documents.map(d=>({...d,hotel_id:hotel})),troubleshooting_cache:snapshot.reviewed_rows.map(r=>({...r,hotel_id:hotel,cache_type:'asset_manual_knowledge'})),cmpri_asset_manual_ocr_jobs:snapshot.ocr_jobs,cmpri_asset_manual_ocr_pages:[]}[table];
    if(!all)throw Error(`Unexpected table in read-only replay: ${table}`);
    let rows=all;
    const q={select(){return q;},eq(k,v){rows=rows.filter(r=>r[k]===v);return q;},in(k,v){rows=rows.filter(r=>v.includes(r[k]));return q;},like(k,v){rows=rows.filter(r=>r[k]?.startsWith(v.slice(0,-1)));return q;},limit(n){rows=rows.slice(0,n);return q;},order(){return q;},maybeSingle:async()=>({data:rows[0]||null,error:null}),then(resolve,reject){return Promise.resolve({data:rows,error:null}).then(resolve,reject);},upsert(){writeAttempts++;throw Error('Writes forbidden in preview replay');},update(){writeAttempts++;throw Error('Writes forbidden in preview replay');}};return q;
  },
  rpc:async(name,input)=>{assert.equal(name,'cmpri_list_asset_files');return {data:files.get(input.p_asset_id)||[],error:null};},
  storage:{from(){return {download:async key=>({data:originals.has(key)?new Blob([originals.get(key)]):null,error:originals.has(key)?null:{message:'Original unavailable'}}),createSignedUrl:async key=>({data:links.has(key)?{signedUrl:links.get(key)}:null,error:links.has(key)?null:{message:'Original unavailable'}})};}}
};
const results=[];
for(const asset of snapshot.assets){
  const result=await loadUploadedAssetGuide(admin,asset);
  const knowledge=normalizeManualKnowledge(result.manualKnowledge);
  const orders=tickets.filter(t=>t.asset_id===asset.id).map(order=>({...order,...deriveTroubleshootingChecklistContext({...order,asset},knowledge)}));
  for(const order of orders)assert.equal(new Set(order.steps.map(step=>JSON.stringify([step.label,step.kind,step.code,step.source_document_id,step.source_sha256]))).size,order.steps.length,'Repeat excerpts within one source must share one check');
  results.push({asset,result,orders});
  console.log(JSON.stringify({asset:asset.name,status:result.documentation_status,codes:knowledge?.error_codes.length||0,checks:orders.map(o=>o.steps.length),needs_review:knowledge?.source?.coverage?.needs_ocr.length||0}));
}
const ge=results.find(r=>r.asset.model_number==='AZ95E12DACK1');
assert.equal(ge.result.manualKnowledge.error_codes.find(c=>c.code==='4').problem.startsWith('Inside thermistor fault'),true);
assert.equal(ge.result.manualKnowledge.error_codes.find(c=>c.code==='4').action,'');
assert.match(ge.result.manualKnowledge.error_codes.find(c=>c.code==='4').unit_response,/Resistance heating/);
const fried=results.find(r=>r.asset.model_number==='VEA12K34-RTL-B');
assert.match(fried.result.manualKnowledge.error_codes.find(c=>c.code==='3').unit_response,/75°F/);
assert.ok(fried.result.manualKnowledge.source.coverage.needs_ocr.includes(40));
assert.ok(fried.result.manualKnowledge.symptom_rules.filter(r=>r.source_pages.includes(41)).every(r=>r.reference_only));
const friedOrder=fried.orders.find(order=>/cooling issue/i.test(order.issue));
const friedContext=technicianTroubleshootingContext(friedOrder.notes,friedOrder.action_root_cause);
assert.match(friedContext,/Reset breaker.*Installed new t-stat/s);
assert.ok(!friedContext.includes('Approved source:'));
assert.equal(relevantSourcePassages(fried.result.manualKnowledge.source_passages,friedOrder.issue,friedContext)[0].page,41);
for(const order of ge.orders){
  const context=technicianTroubleshootingContext(order.notes,order.action_root_cause);
  assert.ok(!context.includes('|change|'));
  if(/Not Cooling/i.test(order.issue))assert.equal(relevantSourcePassages(ge.result.manualKnowledge.source_passages,order.issue,context)[0].kind,'diagnostic');
}
const enseo=results.find(r=>r.asset.name==='Enseo TV System');
const power=enseo.result.manualKnowledge.symptom_rules.flatMap(r=>r.steps).find(s=>/Perform a Power Cycle/.test(s));
assert.match(power,/Wait 30 seconds/);assert.match(power,/Wait 7 minutes/);
for(const result of results.filter(r=>r.asset.name==='Temptrol Shower Valve'))for(const rule of result.result.manualKnowledge?.symptom_rules||[]){
 if(rule.match[0].startsWith('Valve leaks when shut off')){assert.ok(!rule.match.includes('leaking'));assert.match(rule.steps[0],/washers.*foreign matter/i);}
}
const nav=downloads.find(d=>d.storage_path.endsWith('Navien NPE Service Manual.2015.09.01.pdf'));
const navStructure=await extractPdfManualStructure(originals.get(nav.storage_path));
assert.ok(navStructure.error_codes.some(c=>c.code==='E030'));
assert.ok(navStructure.error_codes.every(c=>c.code.startsWith('E')),'Subcodes must not become separate main fault codes');
// Source file hashes and source-only extraction, not fabricated negative records.
let nativeCalls=0;
const guarded=manualPreviewFetch(async()=>{nativeCalls++;return Response.json({});});
assert.equal((await guarded('https://uavotsoanubpowvyqaii.supabase.co/rest/v1/assets',{method:'PATCH',body:'{}'})).status,403);
assert.equal((await guarded('https://uavotsoanubpowvyqaii.supabase.co/rest/v1/rpc/cmpri_register_asset_file',{method:'POST',body:'{}'})).status,403);
assert.equal(nativeCalls,0);assert.equal(writeAttempts,0);assert.equal(networkAttempts,0);
// Keep optional imports exercised through real PDF bytes; no source content goes in this repository.
assert.equal(typeof inspectManualPdf,'function');assert.equal(typeof resolveManualProcedureReferences,'function');assert.equal(typeof structureManualDocument,'function');assert.equal(typeof uploadedManualHtmlActions,'function');
fs.writeFileSync(path.join(directory,'manual-preview-replay.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify({validated:true,assets:results.length,orders:results.flatMap(r=>r.orders).length,pdfs:originals.size,writeAttempts,networkAttempts}));
