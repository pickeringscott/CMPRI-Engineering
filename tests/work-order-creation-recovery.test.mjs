import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as recovery from '../src/lib/work-orders/creation-recovery.ts';
import { draftFieldsKey } from '../src/lib/work-orders/draft-save.ts';

const identity={hotelId:'hotel-one',userId:'owner-one'};
const fields={staff_first_name:'Sam',location_id:'room-124',issue:'Sink leaks\nKeep this line',notes:'First note\nSecond note',asset_id:null,asset_name:'',category:'Plumbing',priority:'Medium'};
const snapshot=(extra={})=>({version:1,...identity,fields:{...fields},active:null,baseline:'',pending:null,pendingReceipt:'',attachmentCount:2,submissionUncertain:false,...extra});
function storage(){const rows=new Map();return {getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key),rows};}

test('a complete device close/reopen recovers exact text, active draft compare baseline and attachment reminder',()=>{
  const disk=storage(),saved=snapshot({active:{id:'draft-a',revision:4},baseline:draftFieldsKey(fields)});
  assert.equal(recovery.saveCreationRecovery(disk,identity,saved),true);
  const reopened=recovery.readCreationRecovery(disk,identity);
  assert.deepEqual(reopened,saved);
  assert.equal(recovery.canRestoreCreationRecovery(reopened,{...fields,id:'draft-a',revision:4}),true);
  assert.equal(recovery.canRestoreCreationRecovery(reopened,{...fields,id:'draft-a',revision:5}),false);
  assert.equal(recovery.canRestoreCreationRecovery(reopened,{...fields,notes:'A server edit',id:'draft-a',revision:4}),false);
  assert.equal(recovery.canRestoreCreationRecovery(reopened,null),false);
});

test('recovery is scoped to both the verified account and property',()=>{
  const disk=storage();recovery.saveCreationRecovery(disk,identity,snapshot());
  for(const other of [{...identity,userId:'other'}, {...identity,hotelId:'other'}])assert.equal(recovery.readCreationRecovery(disk,other),null);
  disk.setItem(recovery.creationRecoveryKey({...identity,userId:'other'}),disk.getItem(recovery.creationRecoveryKey(identity)));
  assert.equal(recovery.readCreationRecovery(disk,{...identity,userId:'other'}),null);
});

test('an in-flight draft snapshot keeps its original id/payload/receipt instead of giving newer edits its retry identity',()=>{
  const disk=storage(),pending={method:'POST',id:'stable-id',fields:{...fields,notes:'Original request'}};
  assert.equal(recovery.saveCreationRecovery(disk,identity,snapshot({fields:{...fields,notes:'Newer edits'},pending,pendingReceipt:'signed-original-fields-receipt'})),true);
  const restarted=recovery.readCreationRecovery(disk,identity);
  assert.equal(restarted.pending.id,'stable-id');assert.equal(restarted.pending.fields.notes,'Original request');
  assert.equal(restarted.fields.notes,'Newer edits');assert.equal(restarted.pending.uncertain,true);
  assert.equal(restarted.pendingReceipt,'signed-original-fields-receipt');
});

test('arbitrary properties, credentials and selected files are never serialized',()=>{
  const disk=storage(),input=snapshot({access_token:'do-not-store',files:[{name:'private.jpg'}],fields:{...fields,session:'secret'},pending:{method:'PATCH',id:'draft-a',revision:4,fields:{...fields,auth:'secret'},token:'secret'}});
  assert.equal(recovery.saveCreationRecovery(disk,identity,input),true);
  const raw=disk.getItem(recovery.creationRecoveryKey(identity));
  assert.doesNotMatch(raw,/access_token|do-not-store|private\.jpg|session|auth|token/);
  assert.equal(JSON.parse(raw).attachmentCount,2);
});

test('corrupt/oversized values fail safely and do not erase another editor outbox',()=>{
  const disk=storage();disk.setItem('notes-outbox','Pending note');
  for(const value of ['{bad',JSON.stringify(snapshot({fields:{...fields,notes:'x'.repeat(20001)}})),JSON.stringify(snapshot({active:{id:'draft',revision:-1}})),'x'.repeat(100000)]){
    disk.setItem(recovery.creationRecoveryKey(identity),value);assert.equal(recovery.readCreationRecovery(disk,identity),null);
  }
  recovery.clearCreationRecovery(disk,identity);assert.equal(disk.getItem('notes-outbox'),'Pending note');
  assert.equal(recovery.saveCreationRecovery({getItem:()=>null,setItem(){throw Error('quota');}},identity,snapshot()),false);
});

test('a requested different server draft needs explicit comparison and partial forms are recoverable',()=>{
  assert.equal(recovery.canRestoreCreationRecovery(snapshot(),null,'a-requested-draft'),false);
  assert.equal(recovery.hasCreationRecoveryWork(snapshot({fields:{...fields,location_id:'',issue:'Half typed',notes:''},attachmentCount:0})),true);
  assert.equal(recovery.hasCreationRecoveryWork(snapshot({fields:{...fields,staff_first_name:'',location_id:'',issue:'',notes:''},attachmentCount:0})),false);
});

const source=readFileSync(new URL('../src/app/work-orders/page.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let hydrate,persist,restore;
function visit(node){
  if(ts.isFunctionDeclaration(node)&&node.name?.text==='restoreLocalCreation')restore=node.getText(ast);
  if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'){
    const body=node.arguments[0]?.getText(ast)||'';
    if(body.includes('creationRecoveryScope.current === creationScope'))hydrate=body;
    if(body.includes('persistCreationRecoveryRef.current = persist'))persist=body;
  }
  ts.forEachChild(node,visit);
}
visit(ast);
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function pageFixture(disk=storage(),overrides={}){
  const listeners=new Map(),state={},scope='hotel-one:owner-one';
  const context={...recovery,Promise,URLSearchParams,localStorage:disk,console,
    cmpriSession:{hotelId:identity.hotelId,user:{id:identity.userId}},draftsLoaded:true,loadingLocations:false,loadingAssets:false,
    creationRecoveryScope:{current:''},creationScope:scope,creationRecoveryStopped:{current:false},creationRecoveryReady:'',creationRecoveryConflict:null,
    drafts:[],reviewDraft:null,issue:'',notes:'',locationId:'',staffFirstName:'',draftFields:{...fields},
    currentDraftKey:draftFieldsKey(fields),activeDraftId:'',activeDraftRevision:null,lastSavedDraftKey:'',
    pendingDraftSave:{current:null},draftCreationReceipts:{current:new Map()},autoOpenedDraftRef:{current:''},persistCreationRecoveryRef:{current:()=>{}},
    restoreCreationAttachments:async()=>{},persistAttachmentsRef:{current:async()=>true},restoringAttachments:{current:0},
    creationSubmissionUncertain:false,submittingRef:{current:false},confirmedCreationKey:{current:''},confirmedDraftRecovery:{current:null},photos:[],createState:'idle',mainWorkOrderCreated:false,
    window:{location:{search:''},addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)},
    document:{hidden:false,addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)},
    resetWorkOrderForm:(force,preserve)=>{state.reset={force,preserve};},
    ...overrides,
  };
  for(const [setter,key] of Object.entries({setStaffFirstName:'staffFirstName',setLocationId:'locationId',setIssue:'issue',setNotes:'notes',setAssetId:'assetId',setCategory:'category',setPriority:'priority',setManualLocation:'manualLocation',setManualAsset:'manualAsset',setManualCategory:'manualCategory',setManualPriority:'manualPriority',setActiveDraftId:'activeDraftId',setActiveDraftRevision:'activeDraftRevision',setLastSavedDraftKey:'lastSavedDraftKey',setUnconfirmedCreationId:'unconfirmedCreationId',setCreationSubmissionUncertain:'creationSubmissionUncertain',setCreationRecoveryConflict:'creationRecoveryConflict',setMessage:'message',setCreationRecoveryReady:'creationRecoveryReady'}))context[setter]=value=>{context[key]=value;state[key]=value;};
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(restore,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const run=body=>vm.runInContext(ts.transpileModule(`(${body})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return {context,state,listeners,disk,hydrate:()=>run(hydrate),persist:()=>run(persist)};
}

test('actual page hydration waits for verified context and successful initial reads before restoring local fields',async()=>{
  assert.ok(hydrate);assert.ok(persist);assert.ok(restore);
  const disk=storage();recovery.saveCreationRecovery(disk,identity,snapshot());
  const f=pageFixture(disk,{cmpriSession:null});f.hydrate();await flush();assert.equal(f.state.issue,undefined);
  f.context.cmpriSession={hotelId:identity.hotelId,user:{id:identity.userId}};f.context.draftsLoaded=false;
  f.hydrate();await flush();assert.equal(f.state.issue,undefined);
  f.context.draftsLoaded=true;f.hydrate();await flush();
  assert.equal(f.state.issue,fields.issue);assert.equal(f.state.notes,fields.notes);
  assert.equal(f.state.creationRecoveryReady,f.context.creationScope);assert.match(f.state.message,/Restoring selected attachments/);
});

test('actual page does not overwrite a changed saved draft or newly typed form while recovery waits',async()=>{
  for(const overrides of [{drafts:[{...fields,id:'draft-a',revision:5}]},{drafts:[{...fields,id:'draft-a',revision:4}],issue:'Already typing'}]){
    const disk=storage();recovery.saveCreationRecovery(disk,identity,snapshot({active:{id:'draft-a',revision:4},baseline:draftFieldsKey(fields)}));
    const f=pageFixture(disk,overrides);f.hydrate();await flush();
    assert.ok(f.state.creationRecoveryConflict);assert.equal(f.state.issue,undefined);
    const before=disk.getItem(recovery.creationRecoveryKey(identity));f.persist();assert.equal(disk.getItem(recovery.creationRecoveryKey(identity)),before);
  }
});

test('actual page cannot replace recovery with initial empty state, and sign-out keeps its protected text without late rewrites',()=>{
  const disk=storage();recovery.saveCreationRecovery(disk,identity,snapshot());const before=disk.getItem(recovery.creationRecoveryKey(identity));
  const f=pageFixture(disk);f.persist();assert.equal(disk.getItem(recovery.creationRecoveryKey(identity)),before);
  f.context.creationRecoveryReady=f.context.creationScope;f.context.issue=fields.issue;f.persist();
  f.listeners.get('cmpri-workspace-sign-out')();const signedOut=disk.getItem(recovery.creationRecoveryKey(identity));
  assert.equal(f.context.creationRecoveryStopped.current,true);assert.deepEqual(f.state.reset,{force:true,preserve:true});
  f.context.issue='An old late render';f.listeners.get('pagehide')();assert.equal(disk.getItem(recovery.creationRecoveryKey(identity)),signedOut);
});

test('actual page persists uncertain submission before request and does not revive text after a confirmed create',()=>{
  const f=pageFixture(storage(),{creationRecoveryReady:'hotel-one:owner-one',issue:fields.issue,submittingRef:{current:true}});f.persist();
  assert.equal(recovery.readCreationRecovery(f.disk,identity).submissionUncertain,true);
  f.context.confirmedCreationKey.current=f.context.currentDraftKey;f.persist();assert.equal(recovery.readCreationRecovery(f.disk,identity),null);
});


test('an acknowledgement before the next React render persists its confirmed draft identity and compare baseline',()=>{
  const f=pageFixture(storage(),{creationRecoveryReady:'hotel-one:owner-one',issue:fields.issue});
  f.persist();f.context.confirmedDraftRecovery.current={active:{id:'acknowledged-id',revision:7},baseline:draftFieldsKey(fields)};
  f.context.persistCreationRecoveryRef.current();
  const saved=recovery.readCreationRecovery(f.disk,identity);
  assert.equal(saved.active.id,'acknowledged-id');assert.equal(saved.active.revision,7);assert.equal(saved.baseline,draftFieldsKey(fields));
});

test('a prepared POST is recoverable text until its bound receipt is attached immediately before sending',()=>{
  const f=pageFixture(storage(),{creationRecoveryReady:'hotel-one:owner-one',issue:fields.issue,pendingDraftSave:{current:{method:'POST',id:'prepared-id',fields}}});
  f.persist();assert.equal(recovery.readCreationRecovery(f.disk,identity).pending,null);
  f.context.draftCreationReceipts.current.set('prepared-id','signed-original-receipt');
  f.context.persistCreationRecoveryRef.current();
  const sent=recovery.readCreationRecovery(f.disk,identity);assert.equal(sent.pending.id,'prepared-id');assert.equal(sent.pendingReceipt,'signed-original-receipt');
});
