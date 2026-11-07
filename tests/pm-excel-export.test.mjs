import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import AdmZip from 'adm-zip';
function compile(file, dependencies) {
 const exports={};
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
  {exports,Buffer,process,performance,require:name=>{if(name in dependencies)return dependencies[name];throw Error(name)}});
 return exports;
}
const catalog=compile('src/lib/pm/catalog.ts',{'./source-catalog.json':JSON.parse(readFileSync('src/lib/pm/source-catalog.json','utf8'))});
const {exportPmWorkbook}=compile('src/lib/server/pm-excel-export.ts',{'adm-zip':AdmZip,'node:fs/promises':fs,'node:path':path,'../pm/catalog':catalog});
const record=(template_id,period_start,responses,extra={})=>({template_id,period_start,scope_key:'property',responses,...extra});
test('Excel preserves template parts, formulas and cell styles while populating routines, room dates and full form data',async()=>{
 const original=new AdmZip(readFileSync('.bridge/Copy of Preventative Maintenance Tracking - CMPRI.xlsx'));
 const result=await exportPmWorkbook('2026-11-02',[
  record('workbook:daily','2026-11-02',{'daily-7':true,'daily-8':false}),
  record('workbook:weekly','2026-11-02',{'weekly-24':true}),
  record('workbook:monthly:nov','2026-11-01',{'nov-1':true}),
  record('pdf:room-pm-checklist','2026-10-01',{}, {scope_key:'room:101',completed_on:'2026-11-06',form_data:{inspectedBy:'=HYPERLINK("bad")',logEntries:[{location:'<Bathroom> & tub',reading:'5'}]},notes:'Unsaved inspection notes',deficiency_notes:'Follow up',status:'Current form (unsaved)'})
 ]);
 assert.equal(result.updatedCells,5);
 const zip=new AdmZip(result.buffer),read=name=>zip.readAsText(name);
 const changed=new Set(['xl/workbook.xml','xl/_rels/workbook.xml.rels','[Content_Types].xml']);
 for(const part of original.getEntries()) {
  const before=original.readAsText(part.entryName),after=read(part.entryName);
  if(/^xl\/worksheets\/sheet\d+\.xml$/.test(part.entryName)) {
   assert.deepEqual(after.match(/<f\b[^>]*>[\s\S]*?<\/f>/g),before.match(/<f\b[^>]*>[\s\S]*?<\/f>/g));
   assert.deepEqual(after.match(/<mergeCells[\s\S]*?<\/mergeCells>/g),before.match(/<mergeCells[\s\S]*?<\/mergeCells>/g));
   if(before!==after) changed.add(part.entryName);
  } else if(!changed.has(part.entryName)) assert.ok(original.readFile(part.entryName).equals(zip.readFile(part.entryName)),part.entryName);
 }
 const sheets=original.getEntries().filter(e=>/^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName));
 const november=sheets.find(e=>original.readAsText(e.entryName).includes('r="AR5"'));
 assert.ok(november);
 const all=sheets.map(e=>read(e.entryName)).join('');
 assert.match(all,/<c r="P7"[^>]*t="b"><v>1<\/v>/);
 const annual=read('xl/worksheets/sheet3.xml');
 assert.match(annual,/<c r="E10"[^>]*><v>46332<\/v>/);
 const detail=read('xl/worksheets/cmpri-form-data.xml');
 for(const text of ['Unsaved inspection notes','Follow up','Current form (unsaved)','&lt;Bathroom&gt; &amp; tub','=HYPERLINK(&quot;bad&quot;)']) assert.ok(detail.includes(text),text);
 assert.equal(detail.includes('<f>'),false,'Entered strings must never become formulas');
 assert.match(read('xl/workbook.xml'),/fullCalcOnLoad="1"/);
});
test('rejects invalid or oversized workbook requests',async()=>{
 await assert.rejects(exportPmWorkbook('bad',[]));
 await assert.rejects(exportPmWorkbook('2026-02-30',[]));
 await assert.rejects(exportPmWorkbook('2026-11-02',[record('pdf:room-pm-checklist','2026-10-01',{}, {completed_on:'2026-13-01'})]));
 await assert.rejects(exportPmWorkbook('2026-11-02',Array(2001).fill({})));
 await assert.rejects(exportPmWorkbook('2026-11-02',[record('unknown','2026-11-02',{})]));
});

test('export endpoint enforces PM access and returns a timed, downloadable workbook',async()=>{
 let auth=null;
 const {POST}=compile('src/app/api/preventive-maintenance/export/route.ts',{
  'next/server':{NextResponse:Response},'@/lib/server/auth':{requireUser:async()=>auth},
  '@/lib/server/access':{allows:principal=>principal.allowed},'@/lib/server/pm-excel-export':{exportPmWorkbook}
 });
 const request=body=>new Request('http://localhost/api/preventive-maintenance/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await POST(request({}))).status,401);
 auth={principal:{allowed:false}};assert.equal((await POST(request({}))).status,403);
 auth.principal.allowed=true;assert.equal((await POST(request({}))).status,400);
 const response=await POST(request({week:'2026-11-02',entries:[]}));
 assert.equal(response.status,200);assert.match(response.headers.get('Content-Disposition'),/2026-11-02.xlsx/);
 assert.ok(Number(response.headers.get('X-PM-Export-Duration-Ms'))>0);
 assert.equal(new AdmZip(Buffer.from(await response.arrayBuffer())).test(),true);
});
