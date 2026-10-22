import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
import {createTicketWriteQueue} from '../src/lib/work-orders/write-queue.ts';
import {loadTs,ticketReadDependency} from './helpers/load-ts.mjs';

const source=readFileSync('src/app/work-orders/[id]/page.tsx','utf8');
const ast=ts.createSourceFile('ticket.tsx',source,99,true,4);
const names=['setOrder','saveTicket','persistTicket','saveReportedIssue','claimUnassignedWorkOrder','persistClaim'];
const functions={};let blur;
function walk(n){
 if(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))functions[n.name.text]=n.getText(ast);
 if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(ast)==='textarea'&&n.getText(ast).includes('aria-label="Reported Issue"'))blur=n.attributes.properties.find(p=>p.name?.text==='onBlur').initializer.expression.getText(ast);
 ts.forEachChild(n,walk);
}walk(ast);
const code=ts.transpileModule(Object.values(functions).join('\n')+`\nexports.blur=${blur};exports.save=saveTicket;exports.issue=saveReportedIssue;exports.claim=claimUnassignedWorkOrder;`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const id='00000000-0000-4000-8000-000000000001';
const roles=loadTs('src/lib/server/roles.ts');
const editPolicy=loadTs('src/lib/work-order-edit-policy.ts');
const assignment=loadTs('src/lib/server/work-order-assignment.ts');
const tick=()=>new Promise(r=>setImmediate(r));

// Actual PATCH route and actual database revision trigger, with all data isolated in memory.
async function fixture(){
 const db=new PGlite();
 await db.exec(`create table work_orders(id uuid primary key,hotel_id text,created_by text,display_id text,issue text,room text,status text,revision int,technician_name text,last_assigned_technician_name text,notes text,category text,priority text,asset_id uuid,asset_name text,action_root_cause text,parts text,cost numeric,hours numeric,due_by text,location_id uuid,history_actor_user_id text,history_source text);`);
 const baseline=readFileSync('supabase/migrations/20260930180000_cmpri_prod_baseline.sql','utf8');
 const start=baseline.indexOf('CREATE OR REPLACE FUNCTION "public"."cmpri_bump_work_order_revision"');
 await db.exec(baseline.slice(start,baseline.indexOf('$$;',start)+3));
 await db.exec('create trigger revision before insert or update on work_orders for each row execute function cmpri_bump_work_order_revision();');
 await db.query(`insert into work_orders(id,hotel_id,created_by,display_id,issue,room,status,technician_name,last_assigned_technician_name,notes,category,priority,asset_name,action_root_cause,parts) values($1,'hotel','actor','fixture','Original issue','Room 101','Closed','Scott','Scott','Saved history','General','Medium','','','')`,[id]);
 let role='Chief Engineer',fail='',release,hold=false,requests=[],beforeUpdate=null;
 const admin={from(table){assert.equal(table,'work_orders');const filters=[];let patch;const q={select(){return q},eq(k,v){filters.push([k,v]);return q},update(v){patch=v;return q},async maybeSingle(){return run()},async single(){return run()}};
  async function run(){if(patch&&beforeUpdate){const fn=beforeUpdate;beforeUpdate=null;await fn()}
   const entries=Object.entries(patch||{}),params=entries.map(([,v])=>v).concat(filters.map(([,v])=>v));
   const where=filters.map(([k],i)=>`${k}=$${entries.length+i+1}`).join(' and ');
   const sql=patch?`update work_orders set ${entries.map(([k],i)=>`${k}=$${i+1}`).join(',')} where ${where} returning *`:`select * from work_orders where ${where}`;
   const result=await db.query(sql,params);return {data:result.rows[0]||null,error:patch&&!result.rows.length?{code:'PGRST116',message:'conflict'}:null};
  }return q}};
 const principal={identity:{id:'actor'},profile:{id:'actor',role,full_name:'Scott',active:true}};
 const deps={
  'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status||200})}},
  '@/lib/constants':{HOTEL_ID:'hotel'},'@/lib/server/auth':{requireUser:async()=>({principal:{...principal,profile:{...principal.profile,role}},admin})},
  '@/lib/server/access':{allows:(p,c)=>roles.profileAllows(p.profile,c)},'@/lib/server/roles':roles,
  '@/lib/work-order-edit-policy':editPolicy,'@/lib/server/work-order-assignment':assignment,
  '@/lib/server/work-order-mentions':{persistMentionedWorkOrder:async()=>null},
  '@/lib/server/room-ranker':{processRoomRankerSyncForWorkOrder:async()=>{}},
  '@/lib/server/work-order-notification-resolution':{isEngineeringWorkOrderActor:()=>false},
  '@/lib/server/room-availability':{loadCurrentRoomStatuses:async()=>({statuses:new Map()}),currentRoomStatus:()=>null},
  '@/lib/work-order-read-policy':ticketReadDependency('@/lib/work-order-read-policy'),
  '@/lib/server/work-order-reader':{workOrderReader:()=>({canReadTechnical:true})},
  '@/lib/account-display':{},'@/lib/cmpri-location-groups':{},
  '@/lib/uuid':loadTs('src/lib/uuid.ts'),'@/lib/work-order-categories':loadTs('src/lib/work-order-categories.ts'),
 };
 const route=loadTs('src/app/api/work-orders/[id]/route.ts',deps);
 const patch=body=>route.PATCH({json:async()=>body,headers:new Headers()}, {params:Promise.resolve({id})});
 const row=async()=>(await db.query('select * from work_orders')).rows[0];
 const initial=await row(),messages=[],fingerprint=JSON.stringify({issue:initial.issue,status:'Closed',priority:'Medium',notes:initial.notes});
 const ctx={exports:{},order:initial,orderRef:{current:initial},ticketReady:true,ticketWrites:{current:createTicketWriteQueue()},saveInFlight:{current:false},issueSaveCount:{current:0},issueSaving:false,
  issue:'Changed issue',notes:initial.notes,noteDraft:'Unsaved note',stagedNoteIds:[],status:'Open',priority:'Urgent',category:'General',technicianName:'Scott',locationId:'',assetId:'',assets:[],actionRootCause:'',parts:'',cost:'',hours:'',dueBy:'',currentActor:'Scott',cmpriSession:{user:{name:'Scott'},capabilities:['edit_tickets']},canEditTicket:true,canReviewCurrentTicket:true,editingIssue:true,canEditField:()=>true,embedded:false,
  assetSelectionChanged:{current:false},roomContextGeneration:{current:0},setRoomOperationalContext:()=>{},explicitPartSuggestion:()=>'',cleanTicketReportedIssue:s=>s,historyLine:e=>JSON.stringify(e),parseTicketHistory:s=>{try{return [JSON.parse(s)]}catch{return []}},accountRoleDisplayName:()=>'Chief Engineer',getValidSession:async()=>{if(fail==='session')throw Error('Session unavailable');return {access_token:'fixture'}},authorizationHeaders:async()=>({}),
  setOrderState:()=>{},setMessage:v=>messages.push(v),setSaving:v=>ctx.saving=v,setSaveState:()=>{},setEditingIssue:v=>ctx.editingIssue=v,setIssueSaving:v=>ctx.issueSaving=v,
  setIssue:v=>ctx.issue=typeof v==='function'?v(ctx.issue):v,setInitialFingerprint:v=>ctx.fingerprint=typeof v==='function'?v(ctx.fingerprint):v,
  setNotes:v=>ctx.notes=v,setNoteDraft:v=>ctx.noteDraft=v,setStatus:v=>ctx.status=v,setStagedNoteIds:v=>ctx.stagedNoteIds=v,setTechnicianName:v=>ctx.technicianName=v,fingerprint,
  fetch:async(url,options)=>{const body=JSON.parse(options.body);requests.push(body);if(hold){hold=false;await new Promise(r=>release=r)}if(fail==='network')throw Error('Network unavailable');if(fail==='api')return {ok:false,json:async()=>({error:'Rejected fixture'})};const result=await patch(body);if(fail==='lost')throw Error('Response lost');return {ok:result.status===200,json:async()=>fail==='unconfirmed'?{}:result.body}},
 };
 vm.runInNewContext(code,ctx);
 return {ctx,messages,requests,row,patch,db,blur:()=>ctx.exports.blur({currentTarget:{value:ctx.issue}}),save:ctx.exports.save,issue:ctx.exports.issue,claim:ctx.exports.claim,hold(){hold=true},release(){release()},fail(v){fail=v},role(v){role=v},race(fn){beforeUpdate=fn},async flush(){while(ctx.issueSaveCount.current||ctx.saveInFlight.current)await tick()}};
}

test('actual blur without Done saves issue alone, then reopen/save uses its confirmed revision',async()=>{
 const f=await fixture();try{
  f.hold();f.blur();await tick();const saving=f.save('Open');assert.equal(f.ctx.saving,true,'lock the full editor while its captured save waits');assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0],{expected_revision:1,issue:'Changed issue'});
  assert.equal(f.ctx.noteDraft,'Unsaved note');assert.equal(JSON.parse(f.ctx.fingerprint).priority,'Medium');
  f.release();await saving;await f.flush();assert.equal(f.requests.length,2);assert.equal(f.requests[1].expected_revision,2);
  const row=await f.row();assert.equal(row.status,'Open');assert.equal(row.issue,'Changed issue');assert.equal(row.revision,3);assert.match(row.notes,/Unsaved note/);assert.doesNotMatch(f.messages.join(' '),/Save error/);
 }finally{await f.db.close()}
});
test('same-render repeated saves use new revision without needing React to render',async()=>{
 const f=await fixture();try{await f.save('Open');await f.save('Open');assert.deepEqual(f.requests.map(r=>r.expected_revision),[1,2]);assert.equal((await f.row()).revision,3)}finally{await f.db.close()}
});
test('repeated blur/Done deduplicate and edits during the request survive and save in order',async()=>{
 const f=await fixture();try{f.hold();f.blur();await tick();const duplicate=f.issue();f.ctx.issue='Newest lower case text';f.blur();f.release();await duplicate;await f.flush();assert.deepEqual(f.requests.map(r=>[r.expected_revision,r.issue]),[[1,'Changed issue'],[2,'Newest lower case text']]);assert.equal(f.ctx.issue,'Newest lower case text');assert.equal(f.ctx.noteDraft,'Unsaved note');assert.equal(f.ctx.priority,'Urgent');assert.equal(JSON.parse(f.ctx.fingerprint).status,'Closed');}finally{await f.db.close()}
});
for(const failure of ['network','api','session','unconfirmed','lost'])test(`${failure}: retain drafts, surface failure and cancel queued reopen`,async()=>{
 const f=await fixture();try{f.fail(failure);if(failure!=='session')f.hold();f.blur();if(failure!=='session')await tick();const next=f.save('Open');if(failure!=='session')f.release();await next;await f.flush();assert.equal((await f.row()).status,'Closed');assert.equal(f.ctx.issue,'Changed issue');assert.equal(f.ctx.noteDraft,'Unsaved note');assert.equal(f.ctx.orderRef.current.revision,1);assert.match(f.messages.at(-1),/^Save error:/);assert.equal(f.ctx.issueSaving,false);assert.equal(f.ctx.saveInFlight.current,false);assert.equal(f.requests.length,failure==='session'?0:1);
 }finally{await f.db.close()}
});
test('failed blur can be deliberately retried; lost response never silently rebases',async()=>{
 const f=await fixture();try{f.fail('network');await f.issue();f.fail('');await f.issue();assert.equal((await f.row()).issue,'Changed issue');f.ctx.issue='Another edit';f.fail('lost');await f.issue();f.fail('');await f.issue();assert.match(f.messages.at(-1),/Someone changed/);assert.equal(f.ctx.issue,'Another edit')}finally{await f.db.close()}
});
test('real competing writer is protected both before lookup and between lookup/update',async()=>{
 for(const race of [false,true]){const f=await fixture();try{
  const other=()=>f.db.query("update work_orders set issue='Other writer' where id=$1",[id]);if(race)f.race(other);else await other();
  await f.issue();assert.equal((await f.row()).issue,'Other writer');assert.equal(f.ctx.issue,'Changed issue');assert.equal(f.ctx.orderRef.current.revision,1);assert.match(f.messages.at(-1),/changed/);
 }finally{await f.db.close()}}
});
test('blank/oversized issue makes no request and view-only role does not autosave',async()=>{
 const f=await fixture();try{await f.issue(' ');await f.issue('a'.repeat(4001));assert.equal(f.requests.length,0);f.ctx.canEditField=()=>false;await f.issue();assert.equal(f.requests.length,0);assert.equal((await f.row()).revision,1)}finally{await f.db.close()}
});
test('server permissions and validation remain enforced for issue-only PATCH',async()=>{
 const f=await fixture();try{f.role('unknown');assert.equal((await f.patch({expected_revision:1,issue:'Forbidden'})).status,403);f.role('Chief Engineer');assert.equal((await f.patch({expected_revision:1,issue:' '})).status,400);assert.equal((await f.row()).revision,1)}finally{await f.db.close()}
});
test('claim waits for issue save and does not mark unrelated drafts saved',async()=>{
 const f=await fixture();try{f.hold();f.blur();await tick();const claim=f.claim();f.release();await claim;await f.flush();assert.deepEqual(f.requests.map(r=>r.expected_revision),[1,2]);assert.equal(JSON.parse(f.ctx.fingerprint).priority,'Medium');assert.equal(f.ctx.noteDraft,'Unsaved note')}finally{await f.db.close()}
});
test('a no-op save does not cancel a following issue blur',async()=>{
 const f=await fixture();try{f.ctx.issue='Original issue';f.ctx.canEditTicket=false;f.ctx.noteDraft='';const saving=f.save();f.ctx.issue='After no-op';f.blur();await saving;await f.flush();assert.equal((await f.row()).issue,'After no-op');assert.equal(f.requests.length,1)}finally{await f.db.close()}
});
test('modal cancellation waits for the blur save, including before React renders',()=>{
 const callback=source.match(/const cancelTicket = useCallback\(\(\) => \{([\s\S]*?)\n  \},/)[1];
 let closed=0,prompted=0;
 for(const pending of [1,2])vm.runInNewContext(`(()=>{${callback}})()`,{saving:false,issueSaveCount:{current:pending},saveInFlight:{current:false},hasUnsavedChanges:true,setShowCancelConfirm:()=>prompted++,closeEmbeddedTicket:()=>closed++});
 assert.equal(closed,0);assert.equal(prompted,0);
});
