import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createTicketWriteQueue } from '../src/lib/work-orders/write-queue.ts';
const source=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,99,true,4);
let save='';
function walk(n){if(ts.isFunctionDeclaration(n)&&['saveTicket','persistTicket'].includes(n.name?.text))save+=n.getText(ast)+'\n';ts.forEachChild(n,walk);}walk(ast);
assert.ok(save);
const code=ts.transpileModule(save+'\nexports.save=saveTicket;', {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(failure,extra={}){
  const calls={reload:0,fetch:0,requests:[],notes:[],staged:[],saving:[],messages:[],fingerprints:[],status:[]};
  const exports={};
  const ctx={exports,ticketReady:true,noteDraft:"",saveInFlight:{current:false},setNoteDraft:()=>{},parseTicketHistory:line=>{try{return [JSON.parse(line)]}catch{return []}},accountRoleDisplayName:()=>"Engineer",cmpriSession:{capabilities:["edit_tickets"]},order:{id:'order',issue:'Fan noisy',room:'409',status:'Open',revision:7},issue:'Fan noisy',assets:[],assetId:'',category:'General',priority:'Medium',technicianName:'',status:'In Progress',notes:'Unsaved technician note',actionRootCause:'',parts:'',cost:'',hours:'',dueBy:'',currentActor:'Test Engineer',embedded:false,modalToken:'',
    locationId:'',assetSelectionChanged:{current:false},roomContextGeneration:{current:0},setRoomOperationalContext:()=>{},explicitPartSuggestion:()=>'',canEditTicket:true,stagedNoteIds:[],editingIssue:false,canEditField:()=>true,
    cleanTicketReportedIssue:value=>value,historyLine:entry=>JSON.stringify(entry),
    setSaving:v=>calls.saving.push(v),setSaveState:()=>{},setMessage:v=>calls.messages.push(v),setIssue:()=>{},setStatus:v=>calls.status.push(v),setOrder:()=>{},setNotes:v=>calls.notes.push(v),setStagedNoteIds:v=>calls.staged.push(v),setInitialFingerprint:v=>calls.fingerprints.push(v),
    loadTicket:async()=>{calls.reload++;},
    getValidSession:async()=>{if(failure==='session')throw Error('Session unavailable');return {access_token:'fake'};},
    supabase:{auth:{getSession:async()=>({data:{session:{access_token:'fake'}}})}},
    fetch:async(url,options)=>{calls.fetch++;calls.requests.push(JSON.parse(options.body));if(failure==='network')throw Error('Network unavailable');return {ok:failure!=='api',json:async()=>failure==='api'?{error:'Save rejected'}:{workOrder:{id:'order',revision:8}}};},
    window:{setTimeout:()=>{}},router:{push:()=>{}},...extra};
  ctx.orderRef={current:ctx.order};ctx.ticketWrites={current:createTicketWriteQueue()};
  const originalSetOrder=ctx.setOrder;ctx.setOrder=row=>{ctx.orderRef.current=row;originalSetOrder(row)};
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
    fetch:async(url,options)=>{assert.equal(url,'/api/work-orders/order/notes');assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{notes:['Actual finding'],expected_revision:7});return {ok:true,json:async()=>({workOrder:{id:'order',revision:8,notes:'Server attributed finding'}})}}});
  await f.run();assert.equal(f.calls.notes[0],'Server attributed finding');assert.equal(JSON.parse(f.calls.fingerprints[0]).notes,'Server attributed finding');
});


test('own closed report correction sends only issue and location with original revision',async()=>{
 const f=fixture(null,{canEditTicket:false,canEditField:key=>['issue','location_id'].includes(key),order:{id:'order',issue:'Fan noisy',room:'409',location_id:'old-room',status:'Closed',revision:7},issue:'Fan rattles',locationId:'new-room',status:'Closed',notes:'',editingIssue:true});
 await f.run();assert.deepEqual(f.calls.requests,[{expected_revision:7,issue:'Fan rattles',location_id:'new-room'}]);
});
test('unchanged owner save sends no request',async()=>{
 const f=fixture(null,{canEditTicket:false,canEditField:key=>['issue','location_id'].includes(key),order:{id:'order',issue:'Fan noisy',room:'409',location_id:'old-room',status:'Closed',revision:7},locationId:'old-room',status:'Closed',notes:'',editingIssue:true});
 await f.run();assert.equal(f.calls.fetch,0);
});
test('mixed unrelated edits block room correction without discarding edits',async()=>{
 const f=fixture(null,{order:{id:'order',issue:'Fan noisy',room:'409',location_id:'old-room',status:'Closed',revision:7},locationId:'new-room',status:'Closed',priority:'Urgent'});
 await f.run();assert.equal(f.calls.fetch,0);assert.match(f.calls.messages.at(-1),/other field edits/);
});


test('Chief issue-only correction does not submit inferred equipment or other defaults',async()=>{
 const f=fixture(null,{order:{id:'order',can_correct_report:true,issue:'Fan noisy',room:'409',status:'Closed',revision:7},issue:'Fan rattles',status:'Closed',notes:'',editingIssue:true});
 await f.run();assert.deepEqual(f.calls.requests,[{expected_revision:7,issue:'Fan rattles'}]);
});

test('Save includes text still in the editor and retains it on failure',async()=>{
 const good=fixture(null,{noteDraft:'Closed door.'});await good.run();assert.match(good.calls.requests[0].notes,/Closed door/);
 let clears=0;const bad=fixture('network',{noteDraft:'Keep this note',setNoteDraft:()=>clears++});await bad.run();assert.equal(clears,0);
});
test('Submit Note persists only notes, preserving unrelated unsaved fields',async()=>{
 let cleared=false;const f=fixture(null,{noteDraft:'Closed door.',priority:'Urgent',setNoteDraft:()=>{cleared=true},setInitialFingerprint:()=>{}});
 await f.run(undefined,true);assert.deepEqual(Object.keys(f.calls.requests[0]).sort(),['expected_revision','notes']);assert.match(f.calls.requests[0].notes,/Closed door/);assert.equal(cleared,true);assert.equal(f.calls.messages.at(-1),'Note saved.');
});
test('missing confirmation retains draft and concurrent clicks do not duplicate requests',async()=>{
 let release;let count=0;const f=fixture(null,{noteDraft:'Keep me',fetch:async()=>{count++;await new Promise(r=>release=r);return {ok:true,json:async()=>({})}}});
 const first=f.run();await new Promise(r=>setImmediate(r));await f.run();assert.equal(count,1);release();await first;assert.equal(f.calls.notes.length,0);assert.match(f.calls.messages.at(-1),/could not be confirmed/);
});
test('unloaded inventory does not clear the existing asset during save',async()=>{
 const f=fixture(null,{assetId:'existing-equipment',assets:[]});await f.run();assert.equal(f.calls.requests[0].asset_id,'existing-equipment');
});
