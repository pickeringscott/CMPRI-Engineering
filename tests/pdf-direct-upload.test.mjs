import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
function load(path,deps={},globals={}) {
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>n in deps?deps[n]:require(n),Error,TextDecoder,TextEncoder,Uint8Array,File,FormData,Response,crypto,console,...globals});return exports;
}
const hash=b=>createHash('sha256').update(b).digest('hex');
const client=load('../src/lib/pdf-direct-upload.ts');
const server=load('../src/lib/server/pdf-direct-upload.ts',{'@/lib/pdf-direct-upload':client});
const validation=load('../src/lib/stored-pdf-link.ts');
const small=fs.readFileSync(new URL('../public/guides/dormakaba.pdf',import.meta.url));
function fixture(options={}) {
 const stored=new Map(), calls=[], forms=[];let puts=0;
 const list=()=>[...stored].map(([storage_path,bytes])=>({object_id:storage_path,storage_path,size:bytes.length,title:storage_path.split('/').at(-1),object_version:'v1',etag:hash(bytes)}));
 const admin={rpc:async name=>{calls.push(name);assert.equal(name,'cmpri_import_stored_pdfs');return {data:list()};},
 from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:options.missing?null:{id:'asset',updated_at:'now',pdf_import_links:[],documentation_verified_at:options.locked?'now':null}})};return q;},
 storage:{getBucket:async()=>({data:{public:options.public||false,file_size_limit:options.unlimited?null:52428800}}),from:()=>({
 createSignedUploadUrl:async(path,opts)=>{calls.push('sign');assert.equal(opts.upsert,false);return {data:{signedUrl:'https://storage.invalid/'+path}};},
 download:async path=>({data:stored.has(path)?new Blob([stored.get(path)]):null}),
 createSignedUrl:async path=>({data:{signedUrl:'https://storage.invalid/read/'+path}})
 })}};
 const inspect=load('../src/lib/server/stored-pdf-import.ts',{'@/lib/stored-pdf-link':validation,'@/lib/manual-pdf-knowledge':{manualPdfSha256:hash,extractManualPdfText:async()=> 'Manufacturer: Lennox Model: KGC240S4M'}});
 const route=load('../src/app/api/assets/documentation/route.ts',{
 '@/lib/server/pre-consolidation/documentation-route':{},'@/lib/server/consolidation-stage':{dispatchConsolidation:async()=>null},
 '@/lib/server/asset-file-register':{},'@/lib/equipment-pdf-suggestions':load('../src/lib/equipment-pdf-suggestions.ts'),'@/lib/server/pdf-direct-upload':server,'@/lib/server/stored-pdf-import':inspect,'@/lib/stored-pdf-link':validation,
 'next/server':{NextResponse:Response},'@/lib/constants':{HOTEL_ID:'hotel'},
 '@/lib/server/auth':{requireCapability:async()=>options.denied?null:{admin,principal:{profile:{role:'engineer'}}}},
 '@/lib/server/roles':{canEditEquipment:()=>!options.roleDenied},'@/lib/manual-source':{},'@/lib/manual-pdf-knowledge':{},'@/lib/manual-document-catalog':{},'@/lib/server/verified-manual-catalog':{}
 });
 const request=async form=>{forms.push([...form].map(([k,v])=>[k,v]));assert(![...form.values()].some(v=>v instanceof Blob));assert(new TextEncoder().encode([...form].flat().join('')).length<2048);return client.pdfImportResponse(await route.POST({formData:async()=>form}));};
 const browser=load('../src/lib/pdf-direct-upload.ts',{}, {fetch:async(url,init)=>{
  puts++; assert.equal(init.method,'PUT');assert.equal(init.headers['x-upsert'],'false');
  const path=url.replace('https://storage.invalid/','');
  if(options.failUpload)return new Response('upstream unavailable',{status:503});
  if(stored.has(path))return new Response('duplicate',{status:409});
  stored.set(path,new Uint8Array(await init.body.arrayBuffer()));
  if(options.lostResponse){options.lostResponse=false;throw Error('network response lost');}
  return Response.json({Key:path});
 }});
 return {admin,stored,calls,forms,puts:()=>puts,request,run:(bytes=small,name='original.pdf',controller=new AbortController())=>browser.uploadPdfDirect(new File([bytes],name,{type:'application/pdf'}),'asset',request,controller.signal,()=>{})};
}
test('small PDF uses direct storage and returns hash-verified review without saving associations',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.sha256,hash(small));assert.equal(f.puts(),1);assert.equal(r.readable_text,true);assert.equal(r.saved_fields,null);assert(f.forms.every(form=>!form.some(([k])=>k==='file')));assert(f.calls.every(c=>['cmpri_import_stored_pdfs','sign'].includes(c)));
});
test('duplicate and renamed retry reuse one immutable stored original',async()=>{
 const f=fixture(),a=await f.run(),b=await f.run(small,'renamed.pdf');assert.equal(a.file.object_id,b.file.object_id);assert.equal(f.puts(),1);assert.equal(f.stored.size,1);
});
test('lost upload response recovers by inspecting the same object',async()=>{
 const f=fixture({lostResponse:true});await assert.rejects(f.run(),/response lost/);const r=await f.run();assert.equal(r.sha256,hash(small));assert.equal(f.puts(),1);assert.equal(f.stored.size,1);
});
test('storage failure is readable and never completes or saves a link',async()=>{
 const f=fixture({failUpload:true});await assert.rejects(f.run(),/HTTP 503/);assert.equal(f.stored.size,0);assert.equal(f.forms.length,1);
});
test('cancel before authorization sends nothing; retry still works',async()=>{
 const f=fixture(),c=new AbortController();c.abort();await assert.rejects(f.run(small,'original.pdf',c),/abort/i);assert.equal(f.forms.length,0);await f.run();assert.equal(f.stored.size,1);
});
test('cancel after storage transfer preserves original and retry does not upload twice',async()=>{
 const f=fixture(),c=new AbortController();const browser=load('../src/lib/pdf-direct-upload.ts',{}, {fetch:async(url,init)=>{f.stored.set(url.replace('https://storage.invalid/',''),new Uint8Array(await init.body.arrayBuffer()));c.abort();return Response.json({});}});
 await assert.rejects(browser.uploadPdfDirect(new File([small],'original.pdf'),'asset',f.request,c.signal,()=>{}),/abort/i);assert.equal(f.forms.length,1);await f.run();assert.equal(f.puts(),0);assert.equal(f.stored.size,1);
});
for(const [label,bytes] of [['empty',new Uint8Array()],['invalid',new TextEncoder().encode('not a PDF')],['oversize',new Uint8Array(52428801)]])test(`${label} file rejected before network`,async()=>{const f=fixture();await assert.rejects(f.run(bytes),/PDF/);assert.equal(f.forms.length,0);});
for(const opt of ['denied','roleDenied','missing','locked','public','unlimited'])test(`${opt} cannot issue an upload token`,async()=>{const f=fixture({[opt]:true});await assert.rejects(f.run());assert(!f.calls.includes('sign'));assert.equal(f.puts(),0);});
test('completion rejects changed bytes even if object size is unchanged',async()=>{
 const f=fixture();await f.run();const [path,bytes]=[...f.stored][0];const changed=bytes.slice();changed[10]^=1;f.stored.set(path,changed);await assert.rejects(f.run(),/changed since/);
});
test('completion rejects wrong size and non-PDF content',async()=>{
 const f=fixture();await f.run();const [path,bytes]=[...f.stored][0];f.stored.set(path,bytes.slice(0,-1));await assert.rejects(f.run(),/size differs/);const wrong=bytes.slice();wrong[0]=0;f.stored.set(path,wrong);await assert.rejects(f.run(),/not a PDF/);
});
test('plain-text/HTML/empty responses report useful errors without JSON SyntaxError',async()=>{
 await assert.rejects(client.pdfImportResponse(new Response('Request Entity Too Large',{status:413})),/too large/);
 await assert.rejects(client.pdfImportResponse(new Response('<html>bad gateway</html>',{status:502})),/HTTP 502/);
 await assert.rejects(client.pdfImportResponse(new Response('')) ,/unexpected response/);
 await assert.rejects(client.pdfImportResponse(Response.json({error:'Sign in again.'},{status:403})),/Sign in again/);
});
test('exact 50 MiB permitted for authorization, larger and invalid claims rejected',async()=>{
 const f=fixture();const form=new FormData();form.set('sha256','a'.repeat(64));form.set('file_size','52428800');form.set('file_name','no-extension');const r=await server.prepareDirectPdf(f.admin,'hotel','asset',form,false);assert(r.signed_url.endsWith('.pdf'));
 for(const size of ['52428801','0','1.5','NaN']){form.set('file_size',size);await assert.rejects(server.prepareDirectPdf(f.admin,'hotel','asset',form,false));}
 form.set('file_size','100');form.set('sha256','../other');await assert.rejects(server.prepareDirectPdf(f.admin,'hotel','asset',form,false));
});
test('actual Lennox 10,301,661-byte PDF: transfer, independent SHA and real text extraction', {skip:!process.env.LENNOX_PDF_TEST_PATH},async()=>{
 const bytes=fs.readFileSync(process.env.LENNOX_PDF_TEST_PATH);assert.equal(bytes.length,10301661);const f=fixture();const r=await f.run(bytes,'100070.pdf');assert.equal(r.sha256,hash(bytes));assert.equal([...f.stored.values()][0].length,10301661);
 const pdf=load('../src/lib/manual-pdf-knowledge.ts',{'@/lib/manual-document-match':{}});const text=await pdf.extractManualPdfText(new Uint8Array(bytes));assert.match(text,/KGC240S4M/);assert(text.length>10000);assert.equal(hash(bytes),r.sha256);console.log(JSON.stringify({lennoxBytes:bytes.length,sha256:r.sha256,textCharacters:text.length,appForms:f.forms.length,storagePuts:f.puts()}));
});
