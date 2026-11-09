import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const detail=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const create=readFileSync(new URL('../src/app/work-orders/page.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',detail,99,true,4);
function extract(name){let source;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)source=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);assert.ok(source,name);return ts.transpileModule(source+`\nexports.run=${name}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;}
test('guest context loads without the retired Ranker and clears on a non-room location',async()=>{
 let state={};const calls=[];const exports={};const generation={current:0};
 vm.runInNewContext(extract('loadRoomOperationalContext'),{exports,roomContextGeneration:generation,id:"ticket",orderRef:{current:{id:"ticket"}},setOrder:()=>{},
 cmpriSession:{user:{role:'Chief Engineer'},capabilities:['view_dashboard']},getValidSession:async()=>({access_token:'mock'}),
 isRailwayCnGuestName:()=>true,loyaltyTier:()=>null,roomGroupBadge:()=>null,setRoomNextBoundary:()=>{},nextGuestDisplayChange:()=>Date.now()+60000,HOTEL_TIME_ZONE:"UTC",
 resolveRoomRankerContext:(_ok,p)=>({ranker:p,error:''}),
 setRoomOperationalContext:value=>{state=typeof value==='function'?value(state):value},
 fetch:async url=>{calls.push(url);if(url==='/api/room-ranker')await new Promise(r=>finishRanker=r);return {ok:true,json:async()=>url==='/api/room-ranker'?{room:'210'}:{workOrder:{id:'ticket',room:'210',guest_name:'Sample Guest'}}}},
 });
 await exports.run('Room 210');assert.equal(state.guestName,'Sample Guest');assert.deepEqual(calls,['/api/work-orders/ticket']);assert.equal(state.loading,false);
 await exports.run('Lobby');await new Promise(r=>setImmediate(r));assert.equal(state.guestName,'');assert.equal(state.ranker,null);
});
test('metadata deduplication lasts only while the authorized fetch is pending',async()=>{
 const exports={},pending={current:null};let count=0,finish;
 vm.runInNewContext(extract('loadMaintenanceReference'),{exports,cmpriSessionRef:{current:{hotelId:"hotel",user:{id:"actor"}}},maintenancePending:pending,fetchMaintenanceReference:()=>{count++;return new Promise(r=>finish=r)}});
 const a=exports.run(),b=exports.run();assert.equal(a,b);assert.equal(count,1);finish([]);await a;
 const c=exports.run();assert.equal(count,2);finish([]);await c;assert.equal(pending.current,null);
});
test('field controls have individual activation and all Chief statuses expand immediately',()=>{
 for(const field of ['asset_id','category','priority','technician_name','status','due_by','parts','hours','cost','action_root_cause']){
  assert.ok(detail.includes(`editingField === "${field}"`),field);
  assert.ok(detail.includes(`setEditingField("${field}")`),field);
  assert.ok(!detail.includes(`editingIssue && canEditField("${field}")`),field);
 }
 assert.match(detail,/expandOnOpen=\{chief\}/);
 assert.match(detail,/if \(chief && canEditField\("status"\)\) return \["Pending Verification", "Open", "In Progress", "Completed", "Will Not Do", "Closed"\]/);
 assert.match(detail,/Edit reported issue/);assert.match(detail,/>Done<\/button>/);
 assert.doesNotMatch(detail,/noteHeading\(entry.authorRole/);
 assert.match(detail,/entry.actor.trim\(\).split/);
 // Guest indicators moved to a shared component; its rendered badges are
 // exercised separately in room-group-badges.test.mjs.
 assert.match(detail,/<WorkOrderGuestIndicators guest=\{order/);
});
test('creation inputs no longer wait for inventory; drafts retain revision and scoped identity',()=>{
 const input=create.slice(create.indexOf('value={locationId}',create.indexOf('return (')));
 assert.doesNotMatch(input,/disabled=\{loadingLocations \|\| loadingAssets\}/);
 assert.match(detail,/cmpri:ticket-draft:\$\{cmpriSession.hotelId\}:\$\{cmpriSession.user.id\}:\$\{order.id\}/);
 assert.match(detail,/setOrder\(\{ \.\.\.row, revision: recovered.revision \}\)/);
 assert.match(detail,/setNoteDraft\(recovered.noteDraft \|\| ""\)/);
 assert.match(detail,/setStagedNoteIds\(recovered.stagedNoteIds \|\| \[\]\)/);
 assert.match(detail,/if \(!order \|\| !ticketReady \|\| saveInFlight.current\) return/);
});

test('local draft persistence retains text, isolates accounts, and reports storage failures',()=>{
 const code=extract('persistLocalDraft');
 const data=new Map(),storage={setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const changes=[],exports={};
 const ctx={exports,cmpriSession:{hotelId:'hotel-a',user:{id:'actor-a'}},order:{id:'ticket-a',revision:7},initialFingerprint:'{}',currentFingerprint:JSON.stringify({notes:'saved\nstaged',issue:'Local edit'}),recoveredDraft:{current:true},noteDraft:'Closed door.',stagedNoteIds:['staged'],hasUnsavedChanges:true,localStorage:storage,setLocalDraftFailed:value=>changes.push(value)};
 vm.runInNewContext(code,ctx);assert.equal(exports.run(),true);const key='cmpri:ticket-draft:hotel-a:actor-a:ticket-a';
 assert.equal(JSON.parse(data.get(key)).noteDraft,'Closed door.');assert.equal(JSON.parse(data.get(key)).revision,7);
 ctx.cmpriSession={hotelId:'hotel-a',user:{id:'actor-b'}};assert.equal(exports.run(),true);assert.equal(data.size,2);
 ctx.cmpriSession={hotelId:'hotel-a',user:{id:'actor-a'}};ctx.hasUnsavedChanges=false;assert.equal(exports.run(),true);assert.equal(data.has(key),false);assert.equal(data.size,1);
 ctx.hasUnsavedChanges=true;ctx.localStorage={setItem(){throw Error('blocked')}};assert.equal(exports.run(),false);assert.equal(changes.at(-1),true);
 ctx.localStorage=storage;assert.equal(exports.run(),true);assert.equal(changes.at(-1),false);
});

test('close and keep draft retries the current write and never closes after a failure or with pending attachments',()=>{
 const exports={};let closed=0,writes=0,success=false,saved='',failed=false;
 const ctx={exports,saving:false,hasPendingNoteMedia:false,cmpriSession:{hotelId:'hotel',user:{id:'actor'}},order:{id:'ticket',revision:3},initialFingerprint:'{}',currentFingerprint:JSON.stringify({issue:'Latest edit'}),recoveredDraft:{current:true},noteDraft:'New note',stagedNoteIds:[],hasUnsavedChanges:true,
  localStorage:{setItem(_key,value){writes++;if(!success)throw Error('storage full');saved=value}},setLocalDraftFailed:value=>{failed=value},closeEmbeddedTicket:()=>closed++};
 vm.runInNewContext(extract('persistLocalDraft'),ctx);ctx.persistLocalDraft=exports.run;
 vm.runInNewContext(extract('closeAndKeepDraft'),ctx);
 exports.run();assert.equal(writes,1);assert.equal(closed,0,'failed write keeps the editor open');assert.equal(failed,true);
 success=true;ctx.hasPendingNoteMedia=true;exports.run();assert.equal(writes,1);assert.equal(closed,0,'unuploaded files are not silently lost');
 ctx.hasPendingNoteMedia=false;exports.run();assert.equal(writes,2);assert.equal(closed,1);assert.equal(failed,false);assert.equal(JSON.parse(saved).fields.issue,'Latest edit');
 assert.match(detail,/The draft could not be saved on this device/);
 assert.match(detail,/Selected attachments are not saved in a device draft/);
});

test('actual recovery restores unsaved text and keeps stale revision instead of overwriting concurrent work',()=>{
 const start=detail.indexOf('      try {\n        const identity = cmpriSessionRef.current;');
 const end=detail.indexOf('      recoveredDraft.current = true;',start);assert.ok(start>0&&end>start);
 const code=ts.transpileModule(detail.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const changes={};const setters=['LocationId','Issue','AssetId','Category','Priority','TechnicianName','Status','Notes','ActionRootCause','Parts','Cost','Hours','DueBy','NoteDraft','StagedNoteIds','Order','Message'];
 const fields={locationId:'room',issue:'Local issue',assetId:'asset',category:'General',priority:'High',technicianName:'Sam',status:'Open',notes:'Original\nStaged',actionRootCause:'',parts:'',cost:'',hours:'',dueBy:''};
 const ctx={background:false,cmpriSessionRef:{current:{hotelId:'hotel',user:{id:'actor'}}},row:{id:'ticket',revision:8},assetSelectionChanged:{current:false},localStorage:{getItem:key=>{assert.equal(key,'cmpri:ticket-draft:hotel:actor:ticket');return JSON.stringify({version:1,revision:7,fields,noteDraft:'Closed door.',stagedNoteIds:['Staged']})}}};
 for(const setter of setters)ctx['set'+setter]=value=>{changes[setter]=value};vm.runInNewContext(code,ctx);
 assert.equal(changes.NoteDraft,'Closed door.');assert.equal(changes.Notes,'Original\nStaged');assert.equal(changes.Order.revision,7);assert.match(changes.Message,/changed/);assert.equal(ctx.assetSelectionChanged.current,true);
});

test('discard affects only the selected local draft and never closes after a storage failure',async()=>{
 const exports={},removed=[],messages=[];let closed=0;const recovered={current:true};
 const ctx={exports,saving:false,cmpriSession:{hotelId:'hotel',user:{id:'actor'}},order:{id:'ticket'},recoveredDraft:recovered,localStorage:{removeItem:key=>removed.push(key)},closeEmbeddedTicket:async beforeClose=>{try{beforeClose?.();closed++;}catch(error){messages.push(error.message);}},setMessage:text=>messages.push(text)};
 vm.runInNewContext(extract('discardLocalDraftAndClose'),ctx);exports.run();await Promise.resolve();assert.deepEqual(removed,['cmpri:ticket-draft:hotel:actor:ticket']);assert.equal(recovered.current,false);assert.equal(closed,1);
 ctx.localStorage={removeItem(){throw Error('blocked')}};recovered.current=true;exports.run();await Promise.resolve();assert.equal(closed,1);assert.equal(recovered.current,true);assert.match(messages.at(-1),/still here/);
});

test('Chief Engineer pending markers track saved values, revert and save outcomes only', async () => {
 const {pendingTicketField}=await import('../src/lib/work-orders/pending-field.ts');
 const saved=JSON.stringify({category:'General',priority:'Medium',technicianName:'Scott',hours:'1',cost:'2.50',dueBy:'2026-10-16'});
 for(const key of ['category','priority','technicianName','hours','cost','dueBy']) {
  assert.equal(pendingTicketField(true,saved,saved,key),false,'focus does not change a value');
  const draft=JSON.stringify({...JSON.parse(saved),[key]:'changed'});
  assert.equal(pendingTicketField(true,saved,draft,key),true);
  assert.equal(pendingTicketField(false,saved,draft,key),false,'other roles have no marker');
  assert.equal(pendingTicketField(true,saved,saved,key),false,'revert clears');
  assert.equal(pendingTicketField(true,saved,draft,key),true,'failed save retains old baseline');
  assert.equal(pendingTicketField(true,draft,draft,key),false,'successful save advances baseline');
 }
 assert.equal(pendingTicketField(true,saved,JSON.stringify({...JSON.parse(saved),hours:'1.00'}),'hours'),false);
 assert.equal(pendingTicketField(true,'',saved,'priority'),false);
 assert.match(detail,/onBlur=\{\(event\) => \{ void saveReportedIssue\(event.currentTarget.value\); \}\}/);
 assert.equal((detail.match(/onDismiss=\{chief \? \(\) => setEditingField\(null\) : undefined\}/g)||[]).length,5);
 assert.match(detail,/data-pending-field=\{key\}[\s\S]*?fontSize: "inherit"/);
 assert.doesNotMatch(detail,/onBlur=\{[^}]*saveTicket/);
});
