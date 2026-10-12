import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,99,true,4);
let save;
function walk(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='saveTicket')save=n.getText(ast);ts.forEachChild(n,walk);}walk(ast);
assert.ok(save);
const code=ts.transpileModule(save+'\nexports.save=saveTicket;', {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(failure,extra={}){
  const calls={reload:0,fetch:0,requests:[],notes:[],staged:[],saving:[],messages:[],fingerprints:[],status:[]};
  const exports={};
  const ctx={exports,order:{id:'order',issue:'Fan noisy',room:'409',status:'Open',revision:7},issue:'Fan noisy',assets:[],assetId:'',category:'General',priority:'Medium',technicianName:'',status:'In Progress',notes:'Unsaved technician note',actionRootCause:'',parts:'',cost:'',hours:'',dueBy:'',currentActor:'Test Engineer',embedded:false,modalToken:'',
    canEditField:()=>true,
    cleanTicketReportedIssue:value=>value,historyLine:entry=>JSON.stringify(entry),
    setSaving:v=>calls.saving.push(v),setSaveState:()=>{},setMessage:v=>calls.messages.push(v),setIssue:()=>{},setStatus:v=>calls.status.push(v),setOrder:()=>{},setNotes:v=>calls.notes.push(v),setStagedNoteIds:v=>calls.staged.push(v),setInitialFingerprint:v=>calls.fingerprints.push(v),
    loadTicket:async()=>{calls.reload++;},
    getValidSession:async()=>{if(failure==='session')throw Error('Session unavailable');return {access_token:'fake'};},
    supabase:{auth:{getSession:async()=>({data:{session:{access_token:'fake'}}})}},
    fetch:async(url,options)=>{calls.fetch++;calls.requests.push(JSON.parse(options.body));if(failure==='network')throw Error('Network unavailable');return {ok:failure!=='api',json:async()=>failure==='api'?{error:'Save rejected'}:{workOrder:{id:'order'}}};},
    window:{setTimeout:()=>{}},router:{push:()=>{}},...extra};
  vm.runInNewContext(code,ctx);return {calls,run:exports.save};
}
for(const failure of ['api','network','session'])test(`${failure} failure keeps edits and staged notes and restores Save`,async()=>{
  const f=fixture(failure);await f.run();assert.equal(f.calls.reload,0);assert.deepEqual(f.calls.notes,[]);assert.deepEqual(f.calls.staged,[]);assert.equal(f.calls.saving.at(-1),false);assert.match(f.calls.messages.at(-1),/^Save error:/);
});
test('successful Save fingerprints the same notes it commits',async()=>{
  const f=fixture();await f.run();assert.equal(f.calls.fetch,1);assert.equal(f.calls.notes.length,1);assert.equal(JSON.parse(f.calls.fingerprints[0]).notes,f.calls.notes[0]);assert.match(f.calls.notes[0],/Unsaved technician note/);assert.match(f.calls.notes[0],/Status/);
});
test('blank issue stops before any save request',async()=>{const f=fixture(null,{issue:' '});await f.run();assert.equal(f.calls.fetch,0);assert.equal(f.calls.messages.at(-1),'Reported Issue is required.');});

test('ticket save sends the original database revision',async()=>{
  const f=fixture();await f.run();assert.equal(f.calls.requests[0].expected_revision,7);
});
test('one-click approval saves pending edits and changes status to Open in the same request',async()=>{
  const f=fixture(null,{order:{id:'order',issue:'Fan noisy',room:'409',status:'Pending Verification',revision:7},status:'Pending Verification',notes:'Submitter comments'});
  await f.run('Open');
  assert.equal(f.calls.fetch,1);
  assert.equal(f.calls.requests[0].status,'Open');
  assert.equal(f.calls.requests[0].issue,'Fan noisy');
  assert.match(f.calls.requests[0].notes,/Submitter comments/);
  assert.equal(f.calls.status[0],'Open');
});
test('Approve triggers the save operation directly without a second button action',()=>{
  assert.match(source,/<button type="button" onClick=\{\(\) => \{ void saveTicket\("Open"\); \}\}[^>]*>Approve/);
});


test('note-only save uses attributed append endpoint and saved history', async()=>{
  const f=fixture(null,{canEditField:()=>false,canReviewCurrentTicket:false,canAddWorkOrderNotes:true,isTechnician:true,
    cmpriSession:{capabilities:['add_work_order_notes']},stagedNoteIds:['staged-line'],parseTicketHistory:()=>[{text:'Actual finding'}],
    fetch:async(url,options)=>{assert.equal(url,'/api/work-orders/order/notes');assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{notes:['Actual finding'],expected_revision:7});return {ok:true,json:async()=>({workOrder:{id:'order',notes:'Server attributed finding'}})}}});
  await f.run();assert.equal(f.calls.notes[0],'Server attributed finding');assert.equal(JSON.parse(f.calls.fingerprints[0]).notes,'Server attributed finding');
});
