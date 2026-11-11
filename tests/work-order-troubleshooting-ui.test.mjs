import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import * as taskReview from '../src/lib/pm/task-review.ts';
import {sourceSemantics} from '../src/lib/work-orders/source-semantics.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'https://cmpri.test'});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', {value:dom.window.navigator, configurable:true});
const React = await import('react');
const {createRoot} = await import('react-dom/client');
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/WorkOrderTroubleshootingChecklist.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const visitSource = readFileSync(new URL('../src/lib/work-orders/troubleshooting-visits.ts', import.meta.url), 'utf8');
const visitCode = ts.transpileModule(visitSource, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const guideSource = readFileSync(new URL('../src/lib/work-orders/troubleshooting-checklist.ts', import.meta.url), 'utf8');
const guideAst = ts.createSourceFile('guide.ts', guideSource, ts.ScriptTarget.Latest, true);
const visualFunction = guideAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='troubleshootingTaskVisual').getText(guideAst);
const visualModule = {exports:{}, taskComplete:taskReview.taskComplete};
vm.runInNewContext(ts.transpileModule(visualFunction,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,visualModule);
const deferred = () => { let resolve; const promise = new Promise(r=>{resolve=r;}); return {promise,resolve}; };
const session = (id='tech-a',name='Alex Technician') => ({hotelId:'hotel-a',user:{id,name,role:'Technician'},capabilities:['view_work_orders']});

function harness(options={}) {
  const ledgers=options.ledgers || new Map(), storage=options.storage || new Map(), journals=options.journals || new Map(), notes=options.notes || [], finalized=options.finalized || new Set();
  const flushes=[];
  let props={workOrderId:'work-order-a',session:session(),expectedContextIdentity:'issue-a',ticketRevision:1,reportedIssue:'Washer not draining',equipmentName:'Fictional Washer',manualUrl:'https://cmpri.test/manual.pdf',sourceFileName:'Washer service manual.pdf',sourceStoragePath:'hotel-a/assets/washer/registered-manual.pdf',visitId:crypto.randomUUID(),registerExitFlush:flush=>{flushes.push(flush);return ()=>{};},...options.props};
  let authId=props.session.user.id, authCallback, override=options.fetch;
  const requests=[],invalidations=[],copies=[],listeners=new Set();
  const actor=()=>({id:props.session.user.id,name:props.session.user.name,role:options.actorRole || 'technician'});
  const ledger=()=>{const key=props.expectedContextIdentity;if(!ledgers.has(key))ledgers.set(key,{revision:0,taskStates:{}});return ledgers.get(key);};
  const payload=()=>({contextKey:'key-'+props.expectedContextIdentity,contextIdentity:props.expectedContextIdentity,revision:ledger().revision,actor:actor(),canEdit:options.canEdit!==false,canClearAll:options.canClearAll ?? actor().role==='chief',canClearOwn:options.canClearOwn!==false,canSeePendingReview:options.canSeePendingReview ?? actor().role==='chief',steps:options.steps?.(props) || [{id:'step-1',label:'Inspect drain hose',sourcePages:[4],sourceUrl:'https://cmpri.test/source.pdf',kind:'symptom'},{id:'step-2',label:'Check the drain fault circuit',sourcePages:[5],kind:'error-code',code:'F1'}],taskStates:structuredClone(ledger().taskStates),pendingVisits:[...journals].filter(([id])=>!finalized.has(id)).map(([id,events])=>({visitId:id,eventCount:events.length,startedAt:'2026-11-09T00:00:00Z',lastEventAt:'2026-11-09T00:01:00Z'}))});
  const reply=(body,status=200)=>({ok:status<400,status,json:async()=>body});
  const getAuth=async()=>authId?{access_token:'synthetic',user:{id:authId}}:null;
  const fetchFixture=async(url,init)=>{
    const request={url,init,body:init.body?JSON.parse(init.body):null};requests.push(request);
    const replaced=override?.(request,{payload,reply,ledger});if(replaced)return replaced;
    if(url.endsWith('/exit')){
      assert.equal(init.keepalive,true);
      const events=journals.get(request.body.visitId)||[],alreadyFinalized=finalized.has(request.body.visitId);
      if(!alreadyFinalized && events.length)notes.push({visitId:request.body.visitId,events:structuredClone(events)});
      finalized.add(request.body.visitId);
      return reply({ok:true,finalized:true,alreadyFinalized,eventCount:events.length,workOrderRevision:2});
    }
    if(init.method==='PATCH'){
      assert.deepEqual(Object.keys(request.body).sort(),['action','contextKey','expectedRevision','itemId','mutationId','visitId']);
      const events=journals.get(request.body.visitId)||[];
      if(events.some(event=>event.mutationId===request.body.mutationId))return reply(payload());
      if(request.body.expectedRevision!==ledger().revision)return reply({error:'This checklist changed. Reload before continuing.'},409);
      const state=ledger().taskStates[request.body.itemId];
      ledger().taskStates[request.body.itemId]=request.body.action==='clear' ? {status:'empty'} : payload().canSeePendingReview && (!state || state.status==='empty') ? {status:'needs',workerChecked:true,workerId:actor().id,workerName:actor().name} : taskReview.tapTask(state,actor());ledger().revision++;
      events.push(structuredClone(request.body));journals.set(request.body.visitId,events);
    }
    return reply(payload());
  };
  const visits={};
  vm.runInNewContext(visitCode,{exports:visits,Error,crypto,fetch:fetchFixture,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},setTimeout,clearTimeout,BroadcastChannel:options.BroadcastChannel || class {postMessage(){}close(){}},require(name){if(name==='../supabase/client')return {getValidSession:getAuth};throw Error(name);}});
  const exports={};
  vm.runInNewContext(code,{exports,Error,crypto,AbortController,queueMicrotask,console,fetch:fetchFixture,
    require(name){
      if(name==='react'||name==='react/jsx-runtime')return require(name);
      if(name==='@/components/WorkOrderStepMedia')return {default:()=>null};
      if(name==='@/components/CopyButton')return {default:({text,label})=>React.createElement('button',{onClick:()=>copies.push(text)},label)};
      if(name==='@/lib/pm/task-review')return taskReview;
      if(name==='@/lib/work-orders/troubleshooting-checklist')return visualModule.exports;
      if(name==='@/lib/work-orders/troubleshooting-visits')return visits;
      if(name==='@/lib/work-orders/source-semantics')return {sourceSemantics};
      if(name==='@/lib/supabase/client')return {getValidSession:getAuth,createClient:()=>({auth:{onAuthStateChange(callback){authCallback=callback;return {data:{subscription:{unsubscribe(){}}}};}}})};
      if(name==='@/lib/events/browser')return {subscribeResources(topics,load,initial){assert.deepEqual(Array.from(topics),['orders','reference']);listeners.add(load);let active=true;if(initial!==false)queueMicrotask(()=>{if(active)void load();});return ()=>{active=false;listeners.delete(load);};}};
      if(name==='@/lib/data-cache/browser')return {invalidateCachedResources:async topics=>invalidations.push(Array.from(topics))};
      throw Error(name);
    },
  });
  const parent=document.createElement('div');document.body.appendChild(parent);const root=createRoot(parent);
  const render=async(next={})=>{props={...props,...next};await React.act(async()=>root.render(React.createElement(exports.default,props)));};
  const click=async element=>React.act(async()=>element.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));
  const boxes=()=>Array.from(parent.querySelectorAll('[role=checkbox]'));
  const auth=async id=>{authId=id;await React.act(async()=>authCallback('SIGNED_OUT',id?{user:{id}}:null));};
  const dispose=async()=>{await React.act(async()=>root.unmount());parent.remove();};
  return {parent,render,click,boxes,auth,dispose,requests,invalidations,copies,ledgers,ledger,payload,reply,storage,journals,notes,finalized,visitHelpers:visits,flush:async()=>{for(const flush of flushes)await flush();},setFetch:value=>{override=value;},setAuth:id=>{authId=id;},refresh:async()=>React.act(async()=>{await Promise.all([...listeners].map(load=>load()));})};
}

test('technician completion stays green after reload with one top source and no row source controls',async()=>{
  const h=harness();
  try{
    await h.render();assert.equal(h.boxes().length,2);
    assert.equal(h.boxes()[0].getAttribute('aria-checked'),'false');
    assert.ok(!h.parent.textContent.includes('For: Washer not draining · Fictional Washer'));
    await h.click(h.boxes()[0]);
    assert.equal(h.boxes()[0].dataset.previewStatus,'approved');
    assert.equal(h.boxes()[0].dataset.taskStatus,'needs');
    assert.equal(h.boxes()[0].querySelector('span').style.color,'rgb(52, 211, 153)');
    assert.ok(h.parent.textContent.includes('Completed by Alex Technician'));
    assert.ok(!h.parent.textContent.includes('Green means completed'));
    assert.equal(h.parent.querySelectorAll('a').length,1);
    assert.equal(h.parent.querySelector('a').href,'https://cmpri.test/manual.pdf');
    for(const row of h.parent.querySelectorAll('li')) {
      assert.equal(row.querySelectorAll('button').length,1,'the primary role checkbox is the only step control');
      assert.equal(row.querySelectorAll('[role=checkbox]').length,1);
      assert.equal(row.querySelectorAll('a').length,0);
      assert.ok(!/Source:|Washer service manual\.pdf/i.test(row.textContent));
      assert.ok(row.querySelector('iframe[title^="Manual source page"]'));
      assert.notEqual(row.querySelector('button').title,'Clear check');
    }
    assert.equal(h.parent.querySelector('[data-guide-source-file]').textContent,'Source: Washer service manual.pdf');
    assert.ok(!h.parent.querySelector('li').textContent.includes('Washer service manual.pdf'));
    assert.equal(h.parent.querySelectorAll('[data-guide-source-file]').length,1);
    assert.ok(![...h.parent.querySelectorAll('button')].some(b=>/copy|clear check/i.test(b.textContent)));
    assert.deepEqual(h.copies,[]);
    assert.deepEqual(h.invalidations,[['orders']]);
    const reloaded=harness({ledgers:h.ledgers});
    try{await reloaded.render();assert.equal(reloaded.boxes()[0].dataset.previewStatus,'approved');assert.equal(reloaded.boxes().length,2,'completed instructions remain visible');}finally{await reloaded.dispose();}
  }finally{await h.dispose();}
});

test('Chief verifies red technician completion and can clear the whole approved check',async()=>{
  const ledgers=new Map([['issue-a',{revision:1,taskStates:{'step-1':{status:'needs',workerChecked:true,workerId:'tech-a',workerName:'Alex Technician'}}}]]);
  const h=harness({ledgers,actorRole:'chief',props:{session:session('chief','Chief Engineer')}});
  try{
    await h.render();assert.equal(h.boxes()[0].dataset.previewStatus,'needs');
    assert.equal(h.boxes()[0].querySelector('span').style.color,'rgb(239, 68, 68)');
    assert.equal(h.boxes()[0].getAttribute('aria-checked'),'true');
    await h.click(h.boxes()[0]);assert.equal(h.boxes()[0].dataset.previewStatus,'approved');
    assert.ok(h.parent.textContent.includes('Reviewed by Chief Engineer'));
    assert.equal(h.ledger().taskStates['step-1'].workerId,'tech-a');
    await h.click(h.boxes()[0]);assert.equal(h.boxes()[0].dataset.previewStatus,'empty');
    assert.deepEqual(h.ledger().taskStates['step-1'],{status:'empty'},'clear removes worker completion and review');
    assert.ok(!h.parent.textContent.includes('Reviewed by Chief Engineer'));
  }finally{await h.dispose();}
});

test('the Chief checkbox alone cycles blank to red to green to blank',async()=>{
  const h=harness({actorRole:'chief',props:{session:session('chief','Chief Engineer')}});
  try{
    await h.render();assert.equal(h.boxes()[0].dataset.previewStatus,'empty');
    await h.click(h.boxes()[0]);assert.equal(h.boxes()[0].dataset.previewStatus,'needs');
    assert.equal(h.boxes()[0].querySelector('span').style.color,'rgb(239, 68, 68)');
    await h.click(h.boxes()[0]);assert.equal(h.boxes()[0].dataset.previewStatus,'approved');
    await h.click(h.boxes()[0]);assert.equal(h.boxes()[0].dataset.previewStatus,'empty');
    assert.deepEqual(h.ledger().taskStates['step-1'],{status:'empty'});
    assert.ok(![...h.parent.querySelectorAll('button')].some(b=>/copy|clear check/i.test(b.textContent)));
  }finally{await h.dispose();}
});

test('compact source badges reflect only explicit step labels and never change completion colors or policy',async()=>{
  const labels=['DANGER: Disconnect power.','WARNING: Hot surface.','COMPLETE: Test ended.','NOTICE: Record the model.','The pump is not working.','Inspection incomplete.','SUCCESS: Not achieved.','Call service immediately is not required.'];
  const h=harness({steps:()=>labels.map((label,index)=>({id:`step-${index+1}`,label,sourcePages:[],kind:'symptom'})),props:{reportedIssue:'URGENT: the entire system has failed'}});
  try{
    await h.render();
    const rows=[...h.parent.querySelectorAll('li')];
    const expected=[['urgent','Urgent','rgb(239, 68, 68)'],['caution','Caution','rgb(251, 191, 36)'],['success','Complete','rgb(52, 211, 153)'],['information','Information','rgb(125, 211, 252)']];
    for(let index=0;index<expected.length;index++){
      const badge=rows[index].querySelector('[data-source-semantics]');
      assert.equal(badge.dataset.sourceSemantics,expected[index][0]);
      assert.equal(badge.textContent,expected[index][1]);
      assert.equal(badge.style.color,expected[index][2]);
      assert.equal(badge.getAttribute('aria-label'),`Source label: ${expected[index][1]}`);
      assert.equal(h.boxes()[index].getAttribute('aria-checked'),'false','source labels do not check the task');
      assert.equal(h.boxes()[index].querySelector('span').style.color,'rgb(100, 116, 139)','unchecked boxes retain their existing color');
    }
    for(const row of rows.slice(4))assert.equal(row.querySelector('[data-source-semantics]'),null,'urgent issue context and negated labels do not color ordinary steps');
    await h.click(h.boxes()[0]);
    assert.equal(h.boxes()[0].querySelector('span').style.color,'rgb(52, 211, 153)','normal technician completion remains green');
    assert.equal(rows[0].querySelector('[data-source-semantics]').style.color,'rgb(239, 68, 68)','the source badge remains independent of completion');
    await h.click(h.boxes()[4]);
    assert.equal(rows[4].querySelector('[data-source-semantics]'),null,'completing a generic instruction does not invent a source success badge');
    assert.equal(h.requests.filter(request=>request.init.method==='PATCH').length,2);
  }finally{await h.dispose();}
});

test('managers and a generic System Administrator see pending completed steps green',async()=>{
  const ledgers=new Map([['issue-a',{revision:1,taskStates:{'step-1':{status:'needs',workerChecked:true,workerId:'tech-a',workerName:'Alex'}}}]]);
  for(const options of [{actorRole:'manager',canEdit:false,canClearAll:false,props:{session:session('manager','Manager')}},{actorRole:'chief',canClearAll:true,props:{session:session('admin','System Administrator')}}]){
    const h=harness({...options,canSeePendingReview:false,ledgers});
    try{
      await h.render();assert.equal(h.boxes()[0].dataset.previewStatus,'approved');
      assert.equal(h.boxes()[0].querySelector('span').style.color,'rgb(52, 211, 153)');
      assert.ok(!h.parent.textContent.includes('Chief Engineer: blank'));
    }finally{await h.dispose();}
  }
});

test('a different technician chooses whether to continue previous work when the guide opens',async()=>{
  const ledgers=new Map([['issue-a',{revision:1,taskStates:{'step-1':{status:'needs',workerChecked:true,workerId:'other-tech',workerName:'Other Technician'}}}]]);
  const h=harness({actorRole:'technician',canClearAll:true,ledgers});
  try {
    await h.render({isOpen:false});assert.equal(h.parent.querySelector('[aria-label="Previous technician progress"]'),null);
    await h.render({isOpen:true});assert.ok(h.parent.querySelector('[aria-label="Previous technician progress"]'));assert.equal(h.boxes().length,0);
    const button=[...h.parent.querySelectorAll('button')].find(element=>element.textContent==='Continue');
    await h.click(button);assert.equal(h.boxes().length,2);assert.equal(h.boxes()[0].disabled,false);
  } finally { await h.dispose(); }
});

test('pending or conflicting writes never show an optimistic green completion',async()=>{
  const pending=deferred();const h=harness({fetch:r=>r.init.method==='PATCH'?pending.promise:null});
  try{
    await h.render();await h.click(h.boxes()[0]);
    assert.equal(h.boxes()[0].getAttribute('aria-checked'),'false');assert.ok(h.boxes().every(b=>b.disabled));
    assert.ok(h.parent.textContent.includes('Saving…'));
    await React.act(async()=>pending.resolve(h.reply({error:'This checklist changed. Reload before continuing.'},409)));
    assert.equal(h.boxes().length,0);assert.ok(h.parent.querySelector('[role=alert]').textContent.includes('This checklist changed'));
    assert.equal(h.invalidations.length,0);
    await h.click([...h.parent.querySelectorAll('button')].find(b=>b.textContent==='Reload checklist'));
    assert.equal(h.boxes()[0].getAttribute('aria-checked'),'false');
  }finally{await h.dispose();}
});

test('a late response cannot restore a previous issue or equipment checklist',async()=>{
  const pending=deferred();let reads=0;const h=harness({fetch:r=>r.init.method==='GET'&&++reads===1?pending.promise:null});
  try{
    await h.render();const old=h.payload();old.steps[0].label='Old equipment instruction';
    await h.render({expectedContextIdentity:'issue-b',reportedIssue:'Current issue',equipmentName:'Current Equipment'});
    assert.equal(h.boxes().length,2);
    await React.act(async()=>pending.resolve(h.reply(old)));
    assert.ok(!h.parent.textContent.includes('Old equipment instruction'));
    assert.equal(h.boxes().length,2);
    assert.ok(h.requests[0].init.signal.aborted);
  }finally{await h.dispose();}
});

test('an account change clears saved marks and rejects a late write response',async()=>{
  const pending=deferred();const h=harness({fetch:r=>r.init.method==='PATCH'?pending.promise:null});
  try{
    await h.render();await h.click(h.boxes()[0]);const old=h.payload();old.taskStates['step-1']={status:'needs',workerChecked:true,workerId:'tech-a'};
    await h.auth(null);assert.equal(h.boxes().length,0);
    await React.act(async()=>pending.resolve(h.reply(old)));
    assert.equal(h.boxes().length,0);assert.ok(h.parent.textContent.includes('Your account changed'));
    assert.equal(h.invalidations.length,0);
  }finally{await h.dispose();}
});

test('unsaved context aborts loading without leaving a stale loading message',async()=>{
  const pending=deferred();const h=harness({fetch:()=>pending.promise});
  try{
    await h.render();assert.ok(h.parent.textContent.includes('Loading saved checklist'));
    await h.render({disabledReason:'Save issue changes before continuing.'});
    assert.ok(!h.parent.textContent.includes('Loading saved checklist'));
    assert.ok(h.parent.textContent.includes('Save issue changes before continuing.'));
    await React.act(async()=>pending.resolve(h.reply(h.payload())));
    assert.equal(h.boxes().length,0);
  }finally{await h.dispose();}
});

test('resource events refresh saved progress without reloading the work-order editor',async()=>{
  const h=harness({actorRole:'chief',props:{session:session('chief','Chief Engineer')}});
  try{
    await h.render();h.ledger().taskStates['step-1']={status:'needs',workerChecked:true,workerId:'tech-a',workerName:'Alex Technician'};h.ledger().revision++;
    await h.refresh();assert.equal(h.boxes()[0].dataset.previewStatus,'needs');
    assert.equal(h.requests.filter(r=>r.init.method==='PATCH').length,0);
  }finally{await h.dispose();}
});

test('a server guide identity mismatch never presents interactive instructions',async()=>{
  const h=harness({fetch:(_r,{payload,reply})=>reply({...payload(),contextIdentity:'different-guide'})});
  try{await h.render();assert.equal(h.boxes().length,0);assert.ok(h.parent.textContent.includes('verified guidance changed'));}finally{await h.dispose();}
});

test('replacing the attached source identity clears the prior upload marks and attribution',async()=>{
  const h=harness();
  try{
    await h.render();await h.click(h.boxes()[0]);assert.equal(h.boxes()[0].dataset.taskStatus,'needs');
    await h.render({expectedContextIdentity:'replacement-upload-path-and-sha',sourceFileName:'Replacement washer manual.pdf',sourceStoragePath:'hotel-a/assets/washer/replacement.pdf'});
    assert.equal(h.boxes()[0].getAttribute('aria-checked'),'false');
    assert.equal(h.parent.querySelector('[data-guide-source-file]').textContent,'Source: Replacement washer manual.pdf');
    assert.ok(!h.parent.textContent.includes('Source: Washer service manual.pdf'));
    assert.equal(h.ledgers.get('issue-a').taskStates['step-1'].status,'needs','earlier upload history remains separately saved');
  }finally{await h.dispose();}
});

test('a returning owner can clear an approved check when new marks are no longer permitted',async()=>{
  const ledgers=new Map([['issue-a',{revision:3,taskStates:{'step-1':{status:'approved',workerChecked:true,workerId:'tech-a',workerName:'Earlier name',reviewedBy:'Chief'}}}]]);
  const h=harness({ledgers,actorRole:'manager',canEdit:false,canClearAll:false});
  try{
    await h.render();assert.equal(h.boxes()[0].disabled,false);assert.equal(h.boxes()[1].disabled,true);
    await h.click(h.boxes()[0]);assert.deepEqual(h.ledger().taskStates['step-1'],{status:'empty'});
    assert.equal(h.requests.find(r=>r.init.method==='PATCH').body.action,'clear');
  }finally{await h.dispose();}
});

test('a Chief checkbox can clear a pending check when new verification is disabled',async()=>{
  const ledgers=new Map([['issue-a',{revision:1,taskStates:{'step-1':{status:'needs',workerChecked:true,workerId:'other-tech',workerName:'Other Technician'}}}]]);
  const h=harness({ledgers,actorRole:'chief',canEdit:false,props:{session:session('chief','Chief Engineer')}});
  try{
    await h.render();assert.equal(h.boxes()[0].disabled,false);
    assert.equal(h.parent.querySelector('button[aria-label^="Clear step"]'),null);
    await h.click(h.boxes()[0]);
    assert.deepEqual(h.ledger().taskStates['step-1'],{status:'empty'});
  }finally{await h.dispose();}
});

test('all changes including a net-zero check/clear produce one note only when the visit exits',async()=>{
  const h=harness();
  try{
    await h.render();await h.click(h.boxes()[0]);await h.click(h.boxes()[0]);await h.click(h.boxes()[1]);
    assert.equal(h.notes.length,0);assert.equal(h.requests.filter(r=>r.url.endsWith('/exit')).length,0);
    const writes=h.requests.filter(r=>r.init.method==='PATCH');assert.equal(writes.length,3);
    assert.equal(new Set(writes.map(r=>r.body.visitId)).size,1);
    assert.equal(new Set(writes.map(r=>r.body.mutationId)).size,3);
    for(const value of h.storage.values()) assert.ok(JSON.parse(value).every(id=>/^[a-f0-9-]{36}$/.test(id)),'device recovery stores IDs only');
    await h.flush();assert.equal(h.notes.length,1);assert.equal(h.notes[0].events.length,3);
    assert.deepEqual(h.notes[0].events.map(event=>event.action),['toggle','clear','toggle']);
    await h.flush();assert.equal(h.notes.length,1,'repeat exit is idempotent');assert.equal(h.storage.size,0);
  }finally{await h.dispose();}
});

test('lost mutation responses retry the identical mutation ID without duplicating journal events',async()=>{
  const journals=new Map();let lost=false;
  const h=harness({journals,fetch:(r,{ledger})=>{
    if(r.init.method==='PATCH'&&!lost){lost=true;ledger().taskStates[r.body.itemId]={status:'needs',workerChecked:true,workerId:'tech-a',workerName:'Alex Technician'};ledger().revision++;journals.set(r.body.visitId,[structuredClone(r.body)]);return Promise.reject(Error('Response lost after commit'));}
    return null;
  }});
  try{
    await h.render();await h.click(h.boxes()[0]);
    const writes=h.requests.filter(r=>r.init.method==='PATCH');assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);
    assert.equal(h.boxes()[0].dataset.taskStatus,'needs');await h.flush();assert.equal(h.notes[0].events.length,1);
  }finally{await h.dispose();}
});

test('failed exit retains its recovery reference and a retry confirms the same single summary',async()=>{
  const h=harness({fetch:(r,{reply})=>r.url.endsWith('/exit')?reply({error:'Exit note save failed'},503):null});
  try{
    await h.render();await h.click(h.boxes()[0]);await assert.rejects(h.flush(),/Exit note save failed/);
    assert.equal(h.notes.length,0);assert.equal(h.storage.size,1);
    h.setFetch(null);await h.flush();assert.equal(h.notes.length,1);assert.equal(h.storage.size,0);
  }finally{await h.dispose();}
});

test('a retained page finalizer still saves the journal after the guide unmounts',async()=>{
  const h=harness();await h.render();await h.click(h.boxes()[0]);await h.dispose();
  await h.flush();assert.equal(h.notes.length,1);
});

test('a new visit leaves earlier journals pending until deliberate recovery',async()=>{
  const prior=harness();await prior.render();await prior.click(prior.boxes()[0]);await prior.dispose();
  const other=crypto.randomUUID();prior.journals.set(other,[{mutationId:crypto.randomUUID(),action:'toggle'}]);
  const next=harness({ledgers:prior.ledgers,storage:prior.storage,journals:prior.journals,notes:prior.notes,finalized:prior.finalized});
  try{
    await next.render();assert.equal(next.notes.length,0);assert.ok(!next.finalized.has(other));
    assert.ok(next.parent.textContent.includes('Recover earlier summary'));
    assert.equal(next.requests.filter(r=>r.url.endsWith('/exit')).length,0);
    await next.click([...next.parent.querySelectorAll('button')].find(b=>b.textContent==='Recover earlier summary'));
    await React.act(async()=>new Promise(resolve=>setTimeout(resolve,275)));
    assert.equal(next.notes.length,1);assert.ok(!next.finalized.has(other));
    assert.equal(next.requests.filter(r=>r.url.endsWith('/exit')).length,1);
  }finally{await next.dispose();}
});

test('cloned-tab references cannot finalize a visit that another window reports active',async()=>{
  const prior=harness();await prior.render();await prior.click(prior.boxes()[0]);await prior.dispose();
  class ActiveChannel { postMessage(message){queueMicrotask(()=>this.onmessage?.({data:{type:'active',visitId:message.visitId,requestId:message.requestId}}));} close(){} }
  const next=harness({storage:prior.storage,journals:prior.journals,notes:prior.notes,finalized:prior.finalized,BroadcastChannel:ActiveChannel});
  try{
    await next.render();assert.equal(next.notes.length,0);assert.equal(next.requests.filter(r=>r.url.endsWith('/exit')).length,0);
    const recover=[...next.parent.querySelectorAll('button')].find(b=>b.textContent==='Recover earlier summary');await next.click(recover);
    assert.ok(next.parent.textContent.includes('still open in another window'));assert.equal(next.notes.length,0);
  }finally{await next.dispose();}
});

test('a delayed active-window reply can never trigger automatic earlier-visit finalization',async()=>{
  const peers=new Set();let probes=0;
  class DelayedChannel {
    constructor(){peers.add(this);}
    postMessage(message){if(message.type==='probe')probes++;for(const peer of peers)if(peer!==this)setTimeout(()=>peer.onmessage?.({data:message}),300);}
    close(){peers.delete(this);}
  }
  const prior=harness({BroadcastChannel:DelayedChannel});await prior.render();await prior.click(prior.boxes()[0]);
  const previousId=[...prior.journals.keys()][0];const stop=prior.visitHelpers.registerActiveTroubleshootingVisit(previousId);
  const next=harness({storage:new Map(prior.storage),journals:prior.journals,notes:prior.notes,finalized:prior.finalized,BroadcastChannel:DelayedChannel});
  try{
    await next.render();await next.refresh();await next.flush();
    await new Promise(resolve=>setTimeout(resolve,350));
    assert.equal(probes,0,'passive loading never probes or guesses that an editor has closed');
    assert.equal(next.requests.filter(r=>r.url.endsWith('/exit')).length,0);
    assert.equal(prior.notes.length,0);assert.ok(!prior.finalized.has(previousId));
  }finally{stop();await next.dispose();await prior.dispose();}
});

test('a failed controlled exit leaves its live editor untouched by a later page load',async()=>{
  const prior=harness({fetch:(r,{reply})=>r.url.endsWith('/exit')?reply({error:'Keep editor open'},503):null});
  await prior.render();await prior.click(prior.boxes()[0]);await assert.rejects(prior.flush(),/Keep editor open/);
  const next=harness({storage:new Map(prior.storage),journals:prior.journals,notes:prior.notes,finalized:prior.finalized});
  try{
    await next.render();await next.refresh();await next.flush();
    assert.equal(next.requests.filter(r=>r.url.endsWith('/exit')).length,0);
    assert.equal(prior.notes.length,0);
    await prior.click(prior.boxes()[1]);assert.equal([...prior.journals.values()][0].length,2,'the original editing visit remains live after its failed exit');
  }finally{await next.dispose();await prior.dispose();}
});

test('editing the issue immediately previews new steps without old marks, then loads the saved issue ledger',async()=>{
  const newSteps=[{id:'step-1',label:'Inspect inlet water valve',sourcePages:[8],kind:'symptom'},{id:'step-2',label:'Test the F2 fill circuit',sourcePages:[9],kind:'error-code',code:'F2'}];
  const h=harness({steps:props=>props.expectedContextIdentity==='fill-f2'?newSteps:null});
  try{
    await h.render();await h.click(h.boxes()[0]);const writes=h.requests.filter(r=>r.init.method==='PATCH').length;
    await h.render({expectedContextIdentity:'fill-f2',reportedIssue:'Washer not filling; fault code F2',previewSteps:newSteps,disabledReason:'Save the edited issue before recording checks.'});
    assert.ok(h.parent.textContent.includes('Inspect inlet water valve'));assert.ok(h.parent.textContent.includes('Test the F2 fill circuit'));
    assert.ok(!h.parent.textContent.includes('Inspect drain hose'));assert.ok(h.boxes().every(b=>b.disabled&&b.getAttribute('aria-checked')==='false'));
    await h.click(h.boxes()[0]);assert.equal(h.requests.filter(r=>r.init.method==='PATCH').length,writes);
    await h.render({disabledReason:undefined,previewSteps:undefined,ticketRevision:2});assert.ok(h.boxes().every(b=>!b.disabled&&b.getAttribute('aria-checked')==='false'));
    await h.click(h.boxes()[0]);await h.flush();assert.equal(h.notes.length,1);
    assert.equal(new Set(h.notes[0].events.map(event=>event.contextKey)).size,2,'one visit summary retains changes across issue contexts');
  }finally{await h.dispose();}
});

test('unmatched everyday descriptions request an observable symptom without inventing checks or requiring a code',async()=>{
  const h=harness({steps:()=>[],props:{reportedIssue:'It is acting funny'}});
  try{
    await h.render();assert.equal(h.boxes().length,0);
    assert.ok(!h.parent.textContent.includes('Describe what you see or hear'));
    assert.equal(h.requests.filter(r=>r.init.method==='PATCH').length,0);
    assert.equal(h.parent.querySelectorAll('a').length,1,'only the actual uploaded document is offered for reference');
  }finally{await h.dispose();}
});

test('the actual ticket integration uses the saved issue identity despite display-only room-prefix cleanup',()=>{
  const page=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');
  const ast=ts.createSourceFile('page.tsx',page,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const component=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='WorkOrderTicketEditor');
  const names=['checklistIssueSaved','checklistContext','checklistContextUnsaved','checklistDisabledReason'];
  const declarations=names.map(name=>component.body.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name)).getText(ast));
  const cleaner=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='cleanTicketReportedIssue').getText(ast);
  const compiled=ts.transpileModule(cleaner+'\n'+declarations.join('\n')+'\nglobalThis.result={checklistIssueSaved,checklistContext,checklistDisabledReason};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const check=issue=>{
    const scope={issue,order:{issue:'Room 316: washer not draining',room:'316',reporter_notes:'',asset_id:'washer',location_id:'loc'},assetId:'washer',locationId:'loc',selectedAsset:{id:'washer'},manualKnowledge:{},ticketReady:true,manualLoading:false,saving:false,exitFlushing:false,deriveTroubleshootingChecklistContext:input=>input};
    vm.runInNewContext(compiled,scope);return scope.result;
  };
  const unchanged=check('Washer not draining');
  assert.equal(unchanged.checklistIssueSaved,true);
  assert.equal(unchanged.checklistContext.issue,'Room 316: washer not draining');
  assert.equal(unchanged.checklistDisabledReason,undefined);
  const edited=check('Washer not filling');
  assert.equal(edited.checklistIssueSaved,false);
  assert.equal(edited.checklistContext.issue,'Washer not filling');
  assert.match(edited.checklistDisabledReason,/Save the reported issue/);
});

test('chart branches share their source context while retaining complete accessible labels',async()=>{
 const labels=['MODELS A AND B — NO HOT WATER — Supply on? — Yes: Check the valve.','MODELS A AND B — NO HOT WATER — Supply on? — No: Open the supply.'];
 const h=harness({steps:()=>labels.map((label,index)=>({id:`chart-${index}`,label,sourcePages:[4],kind:'symptom'}))});
 try{
  await h.render();assert.equal(h.parent.querySelectorAll('[data-chart-context]').length,1);
  assert.match(h.parent.querySelector('[data-chart-context]').textContent,/MODELS A AND B — NO HOT WATER/);
  assert.equal(h.parent.querySelectorAll('summary').length,1);
  assert.equal(h.parent.querySelectorAll('li')[0].querySelector('p').textContent,'Supply on? — Yes: Check the valve.');
  assert.equal(h.boxes()[0].getAttribute('aria-label'),`Step 1: ${labels[0]}`);
 }finally{await h.dispose();}
});
