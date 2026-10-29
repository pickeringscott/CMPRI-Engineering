import * as workOrderReferences from '../src/lib/work-order-reference.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as roles from '../src/lib/server/roles.ts';
const mentionPolicy = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/staff-notes.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:mentionPolicy,require:name=>name==='./work-order-reference.js'?workOrderReferences:roles});

const source=readFileSync(new URL('../src/components/StaffNotes.tsx',import.meta.url),'utf8');
test('typed and pasted full mentions are blue while native draft stays exact',async()=>{
 const h=harness();let tree=await h.initialize();
 for(const value of ['@Chief Engineer','before @chief engineer, after','@Deon and @Housekeeping','\ud83d\ude00 @Chief Engineer\nnext line']) {
  h.find(tree,'textarea').props.onChange({target:{value,selectionStart:value.length}});tree=h.render();
  assert.equal(h.find(tree,'textarea').props.value,value);
  const blue=h.nodes(tree,n=>!!n.props?.['data-composer-mention']);
  assert.ok(blue.length>0);assert.ok(blue.every(n=>n.props.className.includes('text-sky-300')));
  assert.match(h.find(tree,'textarea').props.className,/caret-white/);
 }
 assert.equal(h.posts.length,0);
});
test('first-letter role/user completion supports Tab and touch at middle caret',async()=>{
 const h=harness();let tree=await h.initialize();
 for(const [prefix,expected] of [['h','Housekeeping'],['ho','Housekeeping'],['hou','Housekeeping'],['CH','Chief Engineer'],['d','Deon']]) {
  const value='before @'+prefix+' after';const caret=8+prefix.length;
  h.find(tree,'textarea').props.onChange({target:{value,selectionStart:caret}});tree=h.render();
  const suggestion=h.nodes(tree,n=>n.type==='button'&&n.props['aria-label']===`Complete @${expected}`)[0];assert.ok(suggestion,prefix);
  if(prefix==='hou')suggestion.props.onClick();
  else h.find(tree,'textarea').props.onKeyDown({key:'Tab',nativeEvent:{},preventDefault(){}});
  tree=h.render();assert.equal(h.find(tree,'textarea').props.value,'before @'+expected+'  after');
  assert.ok(h.nodes(tree,n=>n.props?.['data-composer-mention']===expected).length);
 }
 assert.equal(h.posts.length,0);
});
test('semantic role association uses actual IDs, never invented recipients',()=>{
 const directory=mentionPolicy.staffMentionDirectory([{id:'actual-chief',role:'system_admin',secondary_roles:['engineer']}]);
 assert.deepEqual(Array.from(mentionPolicy.staffMentionMatches('@Chief Engineer',directory)[0].mention.userIds),['actual-chief']);
 assert.equal(mentionPolicy.staffMentionCompletion('@h',2,directory).mention.label,'Housekeeping');
 assert.equal(directory.find(x=>x.label==='Housekeeping').userIds.length,0);
 assert.equal(mentionPolicy.staffMentionCompletion('@Chief Engineer',15,directory),null);
 assert.equal(mentionPolicy.staffMentionMatches('@Chief Engineers',directory).length,0);
});
function harness(management=true) {
 let cursor=0,states=[],effects=[],posts=[],fail=false,seq=0;
 const payload={notes:[{id:'one',body:'First',author_name:'A',created_at:'2026-10-15T10:00:00Z',parent_id:null},{id:'two',body:'Second',author_name:'B',created_at:'2026-10-15T11:00:00Z',parent_id:'one'}],parents:[],mentions:mentionPolicy.staffMentionDirectory([{id:'chief',role:'system_admin',secondary_roles:['engineer'],full_name:'Scott'},{id:'deon',role:'Lead Housekeeper',full_name:'Deon'}]),tickets:{},management,frontDesk:false,hotelId:'hotel',next:null};
 const react={useState(initial){let i=cursor++;if(!(i in states))states[i]=initial;return [states[i],v=>states[i]=typeof v==='function'?v(states[i]):v];},useRef(initial){let i=cursor++;if(!(i in states))states[i]={current:initial};return states[i];},useCallback(fn){return fn;},useEffect(fn){effects.push(fn);},useLayoutEffect(){}};
 const jsx=(type,props)=>({type,props:props||{}});
 const fakeFetch=async(url,options={})=>{if(options.method==='POST'){posts.push(JSON.parse(options.body));return {ok:!fail,json:async()=>fail?{error:'Offline; draft retained'}:{id:'saved'}};}return {ok:true,json:async()=>payload};};
 const exports={};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require(name){if(name==='@/lib/events/shared-fetch')return {sharedFetch:fakeFetch};if(name==='@/lib/events/browser')return {subscribeResource:()=>()=>{}};if(name==='react')return react;if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};if(name==='@/lib/auth/client-session')return {authorizationHeaders:async()=>({Authorization:'mock'})};if(name==='@/lib/supabase/client')return {};if(name==='@/lib/staff-notes')return mentionPolicy;throw Error(name);},setTimeout,clearTimeout,Date,Map,crypto:{randomUUID:()=>`req-${++seq}`},requestAnimationFrame:fn=>fn(),fetch:fakeFetch,console});
 const render=()=>{cursor=0;effects=[];return exports.default({});};
 function nodes(tree,predicate){const out=[];function visit(x){if(!x||typeof x!=='object')return;if(Array.isArray(x)){x.forEach(visit);return;}if(predicate(x))out.push(x);visit(x.props?.children);}visit(tree);return out;}
 const find=(tree,type)=>nodes(tree,x=>x.type===type)[0];
 const settle=()=>new Promise(r=>setTimeout(r,15));
 return {payload,render,nodes,find,posts,setFail(v){fail=v;},settle,async initialize(){render();effects[0]();await settle();return render();}};
}
test('real component orders by role and places composer at the approved end',async()=>{
 for(const management of [true,false]){
  const h=harness(management),tree=await h.initialize();
  assert.deepEqual(h.nodes(tree,x=>x.props?.['data-staff-note']!==undefined).map(n=>n.props.id),management?['note-one','note-two']:['note-two','note-one']);
  const kinds=h.nodes(tree,x=>x.type==='form'||x.props?.['data-staff-note']!==undefined).map(n=>n.type==='form'?'composer':n.props.id);
  assert.equal(management?kinds.at(-1):kinds[0],'composer');
 }
});
test('Enter posts once, preserves modal, clears only successful composer; failure retains request and draft',async()=>{
 const h=harness();let tree=await h.initialize();let input=h.find(tree,'textarea');
 input.props.onChange({target:{value:'😀 hello',selectionStart:8}});tree=h.render();input=h.find(tree,'textarea');
 let prevented=0;const enter={key:'Enter',shiftKey:false,nativeEvent:{isComposing:false},preventDefault(){prevented++;}};
 input.props.onKeyDown(enter);input.props.onKeyDown(enter);await h.settle();tree=h.render();
 assert.equal(h.posts.length,1);assert.equal(h.posts[0].body,'😀 hello');assert.equal(h.find(tree,'textarea').props.value,'');assert.ok(h.find(tree,'form'));assert.equal(prevented,2);
 h.setFail(true);h.find(tree,'textarea').props.onChange({target:{value:'retry me',selectionStart:8}});tree=h.render();h.find(tree,'textarea').props.onKeyDown(enter);await h.settle();tree=h.render();
 assert.equal(h.find(tree,'textarea').props.value,'retry me');h.find(tree,'textarea').props.onKeyDown(enter);await h.settle();assert.equal(h.posts[1].requestId,h.posts[2].requestId);
});
test('mention acceptance takes Enter or Tab; Shift+Enter and IME do not post',async()=>{
 const h=harness();let tree=await h.initialize();h.find(tree,'textarea').props.onChange({target:{value:'@de',selectionStart:3}});tree=h.render();
 let prevented=false;h.find(tree,'textarea').props.onKeyDown({key:'Enter',nativeEvent:{isComposing:false},preventDefault(){prevented=true;}});
 tree=h.render();assert.equal(h.find(tree,'textarea').props.value,'@Deon ');assert.equal(h.posts.length,0);assert.equal(prevented,true);
 for(const event of [{key:'Enter',shiftKey:true,nativeEvent:{}},{key:'Enter',nativeEvent:{isComposing:true}},{key:'Tab',nativeEvent:{}}]) h.find(tree,'textarea').props.onKeyDown({...event,preventDefault(){throw Error('Should retain native behavior');}});
 assert.equal(h.posts.length,0);
});

test('real Staff Notes component completes a first name and displays matching WO tags without rewriting history',async()=>{
 const h=harness();
 h.payload.mentions=mentionPolicy.staffMentionDirectory([{id:'scott-id',role:'engineer',full_name:'Scott Reed'}]);
 h.payload.notes[0].body='Keep #261016311 unchanged';
 h.payload.tickets['261016311']={href:'/work-orders/existing-id',preview:'Room 311'};
 let tree=await h.initialize();
 const link=h.nodes(tree,n=>n.type==='a'&&n.props.href==='/work-orders/existing-id')[0];
 assert.equal(link.props.children,'WO#261016311');
 assert.equal(h.payload.notes[0].body,'Keep #261016311 unchanged');
 h.find(tree,'textarea').props.onChange({target:{value:'@Sc',selectionStart:3}});tree=h.render();
 h.find(tree,'textarea').props.onKeyDown({key:'Tab',nativeEvent:{},preventDefault(){}});
 tree=h.render();assert.equal(h.find(tree,'textarea').props.value,'@Scott ');
 assert.equal(h.posts.length,0);
});
