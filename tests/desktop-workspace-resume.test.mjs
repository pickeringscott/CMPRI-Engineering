import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import * as workspace from '../src/lib/ui/workspace-resume.ts';
import {canResumeWorkspaceView} from '../src/lib/ui/workspace-route-access.ts';

const dom=new JSDOM('<div id="root"></div>',{url:'https://cmpri.test/engineering',pretendToBeVisual:true});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=await import('react');
const {createRoot}=await import('react-dom/client');
let verifySession, authorizationChecks=0;
const require=createRequire(import.meta.url), globals={exports:{},window,document,URL,Promise};
globals.require=name=>{
  if(['react','react/jsx-runtime'].includes(name))return require(name);
  if(name==='@/lib/auth/client-session')return {loadCmpriSession:()=>{authorizationChecks++;return verifySession();}};
  if(name==='@/lib/ui/workspace-resume')return workspace;
  if(name==='@/lib/ui/workspace-route-access')return {canResumeWorkspaceView};
  throw Error('Unexpected import '+name);
};
vm.runInNewContext(ts.transpileModule(readFileSync('src/components/desktop/DesktopWorkspaceResume.tsx','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText,globals);
const Component=globals.exports.default;
const session={user:{id:'fixture-user',role:'engineer',secondary_roles:[]},hotelId:'fixture-hotel',capabilities:['view_dashboard','view_work_orders','view_profiles','view_pm','submit']};
const identity=workspace.workspaceIdentity(session);
const options={origin:window.location.origin,isAllowed:view=>canResumeWorkspaceView(session,view)};
const frame=href=>({kind:'frame',key:new URL(href,window.location.origin).pathname,href});
let current, setDesktop, restored, navigated, failures, sessionChanges;
function Harness({principal=session}){
  const [desktop,setState]=React.useState({views:[],zOrder:[]});setDesktop=setState;current=desktop;
  return React.createElement(Component,{session:principal,allowedHrefs:['/notes','/profile','/engineering/preventive-maintenance'],views:desktop.views,zOrder:desktop.zOrder,
    onRestore:value=>{restored.push(value);setState(value);},onNavigate:href=>navigated.push(href),onStorageError:()=>failures++,onSessionChanged:()=>sessionChanges++});
}
function reset(){window.localStorage.clear();window.history.replaceState({},'','/engineering');restored=[];navigated=[];failures=0;sessionChanges=0;authorizationChecks=0;verifySession=async()=>session;}
async function settle(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));}
async function mount(principal=session){const root=createRoot(document.getElementById('root'));await React.act(async()=>{root.render(React.createElement(Harness,{principal}));await settle();});return root;}
async function close(root){await React.act(async()=>root.unmount());}
function seed(patch){assert.equal(workspace.saveWorkspace(window.localStorage,identity,patch,options),true);}

test('desktop restoration preserves its windows/order and sibling modals before saving the first mounted state',async()=>{
  reset();const desktop={views:[frame('/engineering/preventive-maintenance'),{kind:'list',key:'work-order-list'}],zOrder:['work-order-list','/engineering/preventive-maintenance']};
  const modals={views:[frame('/profile')],activeKey:'/profile'};seed({topHref:'/engineering',desktop,modals});
  const root=await mount();
  try{
    assert.equal(restored.length,1);assert.deepEqual(JSON.parse(JSON.stringify(current)),desktop);
    const saved=workspace.readWorkspace(window.localStorage,identity,options);
    assert.deepEqual(saved.desktop,desktop,'an initial empty React state cannot overwrite the recovered window set');
    assert.deepEqual(saved.modals,modals,'desktop writes preserve the other modal host');
  }finally{await close(root);}
});

test('last authorized standalone view is resumed without replacing its saved window state',async()=>{
  reset();const desktop={views:[frame('/profile')],zOrder:['/profile']};seed({topHref:'/notes?tab=journal',desktop});
  const root=await mount();
  try{
    assert.deepEqual(navigated,['/notes?tab=journal']);assert.equal(restored.length,0);
    assert.deepEqual(workspace.readWorkspace(window.localStorage,identity,options).desktop,desktop);
  }finally{await close(root);}
});

test('another account or permission scope cannot revive previously open screens',async()=>{
  reset();seed({topHref:'/notes',desktop:{views:[frame('/profile')],zOrder:['/profile']}});
  const changed={...session,user:{...session.user,id:'different-user'},capabilities:['view_work_orders']};
  const root=await mount(changed);
  try{assert.equal(restored.length,0);assert.deepEqual(navigated,[]);assert.deepEqual(current.views,[]);}
  finally{await close(root);}
});

test('closing a window is durable and cannot resurrect it on the next mount',async()=>{
  reset();seed({desktop:{views:[frame('/profile')],zOrder:['/profile']}});let root=await mount();
  try{
    await React.act(async()=>{setDesktop({views:[],zOrder:[]});await settle();});
    await close(root);root=await mount();
    assert.deepEqual(current.views,[]);assert.deepEqual(workspace.readWorkspace(window.localStorage,identity,options).desktop.views,[]);
  }finally{await close(root);}
});

test('changing the verified principal rebuilds the dashboard without copying its old editors into the new scope',async()=>{
  reset();seed({desktop:{views:[frame('/profile')],zOrder:['/profile']}});const root=await mount();
  try{
    const changed={...session,user:{...session.user,id:'different-user'}};
    await React.act(async()=>{root.render(React.createElement(Harness,{principal:changed}));await settle();});
    window.dispatchEvent(new dom.window.Event('pagehide'));
    assert.equal(sessionChanges,1);
    assert.equal(window.localStorage.getItem(workspace.workspaceStorageKey(workspace.workspaceIdentity(changed))),null);
    assert.equal(workspace.readWorkspace(window.localStorage,identity,options).desktop.views.length,1);
  }finally{await close(root);}
});

function invalidate(){window.dispatchEvent(new dom.window.CustomEvent('cmpri-data-cache-invalidated',{detail:{topics:['session']}}));}

test('same-scope cache reconciliation verifies once and resumes pending navigation without a reload',async()=>{
  reset();seed({desktop:{views:[frame('/profile')],zOrder:['/profile']}});const root=await mount();
  let release;verifySession=()=>new Promise(resolve=>release=resolve);
  try{
    await React.act(async()=>{invalidate();invalidate();setDesktop({views:[],zOrder:[]});await settle();});
    window.dispatchEvent(new dom.window.Event('pagehide'));
    assert.equal(authorizationChecks,1);assert.equal(sessionChanges,0);
    assert.equal(workspace.readWorkspace(window.localStorage,identity,options).desktop.views.length,1);
    await React.act(async()=>{release(session);await settle();});
    assert.equal(sessionChanges,0);
    assert.deepEqual(workspace.readWorkspace(window.localStorage,identity,options).desktop.views,[]);
  }finally{await close(root);}
});

test('changed or revoked fresh authorization rebuilds before adopting another principal',async()=>{
  for(const next of [{...session,capabilities:['view_work_orders']},null]){
    reset();seed({desktop:{views:[frame('/profile')],zOrder:['/profile']}});const root=await mount();
    verifySession=async()=>{if(!next)throw Error('Fixture revoked');return next;};
    try{
      await React.act(async()=>{invalidate();await settle();});
      await React.act(async()=>{setDesktop({views:[],zOrder:[]});await settle();});
      window.dispatchEvent(new dom.window.Event('pagehide'));invalidate();
      assert.equal(sessionChanges,1);assert.equal(authorizationChecks,1);
      assert.equal(workspace.readWorkspace(window.localStorage,identity,options).desktop.views.length,1);
    }finally{await close(root);}
  }
});

test('sign-out during fresh authorization cannot resume persistence or reload before revocation finishes',async()=>{
  reset();seed({desktop:{views:[frame('/profile')],zOrder:['/profile']}});const root=await mount();
  let release;verifySession=()=>new Promise(resolve=>release=resolve);
  try{
    invalidate();
    await React.act(async()=>window.dispatchEvent(new dom.window.Event('cmpri-workspace-sign-out')));
    await React.act(async()=>{release(session);await settle();});
    invalidate();window.dispatchEvent(new dom.window.Event('pagehide'));
    assert.equal(sessionChanges,0);assert.equal(authorizationChecks,1);
    assert.equal(window.localStorage.getItem(workspace.workspaceStorageKey(identity)),null);
  }finally{await close(root);}
});

test('sign-out clears only navigation and late pagehide cannot recreate it or erase protected editor drafts',async()=>{
  reset();seed({desktop:{views:[frame('/profile')],zOrder:['/profile']}});window.localStorage.setItem('fixture-notes-outbox','unsynced text');
  const root=await mount();
  try{
    await React.act(async()=>window.dispatchEvent(new dom.window.Event('cmpri-workspace-sign-out')));
    invalidate();
    window.dispatchEvent(new dom.window.Event('pagehide'));
    assert.equal(sessionChanges,0);assert.equal(authorizationChecks,0);
    assert.equal(window.localStorage.getItem(workspace.workspaceStorageKey(identity)),null);
    assert.equal(window.localStorage.getItem('fixture-notes-outbox'),'unsynced text');
  }finally{await close(root);}
});

test('blocked browser storage reports recovery failure without crashing or claiming a saved workspace',async()=>{
  reset();const descriptor=Object.getOwnPropertyDescriptor(window,'localStorage');
  Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new Error('Fixture storage denied');}});
  let root;
  try{root=await mount();assert.equal(failures,1);assert.deepEqual(restored,[]);}
  finally{if(root)await close(root);Object.defineProperty(window,'localStorage',descriptor);}
});

test.after(()=>dom.window.close());
