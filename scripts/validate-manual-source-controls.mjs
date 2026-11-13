// Source-control acceptance uses private Supabase snapshots, never invented assets/accounts.
// Recorded signed URLs exercise the UI transport only; no live authentication claim.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
import {loadTs} from '../tests/helpers/load-ts.mjs';

const directory=process.env.CMPRI_MANUAL_SNAPSHOT_DIR;
if(!directory){console.error('CMPRI_MANUAL_SNAPSHOT_DIR with actual records is required.');process.exit(2);}
const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
const replay=read('manual-preview-replay.json'),account=read('manual-preview-session.json');
const documents=read('live-manual-snapshot.json').documents.flatMap(group=>group.documents||[]);
const sources=replay.flatMap(row=>(row.result.manualKnowledge?.sources||[]).map(source=>({source,asset:row.asset})))
  .filter((row,index,all)=>all.findIndex(other=>other.source.registered_file_id===row.source.registered_file_id)===index)
  .filter(row=>documents.some(document=>document.storage_path===row.source.storage_path&&document.url));
assert.ok(sources.length>=2,'Two actually registered manuals are required.');
assert.ok(account.user?.id,'An actual account snapshot is required.');
const [first,second]=sources;
const href=row=>row.source.file_url+'#page=1';
const signed=row=>documents.find(document=>document.storage_path===row.source.storage_path).url+'#page=1';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost:3118'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=await import('react'),{createRoot}=await import('react-dom/client');
const require=createRequire(import.meta.url);
const activeSession={access_token:'offline-read-only-replay',user:{id:account.user.id}};
let session=activeSession,authListener,fetchCount=0,popupBlocked=false;
const popups=[];
dom.window.open=()=>{
  if(popupBlocked)return null;
  const popup={opener:dom.window,closed:false,url:'about:blank',close(){this.closed=true;},location:{replace(url){popup.url=url;}}};
  popups.push(popup);return popup;
};
const sourceFor=url=>sources.find(row=>new URL(row.source.file_url,dom.window.location.origin).search===new URL(url,dom.window.location.origin).search);
const responseFor=url=>{
  const row=sourceFor(url);assert.ok(row,'Only a real registered source may be requested.');
  return Response.json({url:documents.find(document=>document.storage_path===row.source.storage_path).url});
};
let transport=async url=>responseFor(url);
const component=loadTs('src/components/ManualSourceLink.tsx',{
  react:require('react'),'react/jsx-runtime':require('react/jsx-runtime'),
  '@/lib/supabase/client':{
    getValidSession:async()=>session,
    createClient:()=>({auth:{onAuthStateChange(callback){authListener=callback;return {data:{subscription:{unsubscribe(){if(authListener===callback)authListener=null;}}}};}}}),
  },
},{window:dom.window,URL,AbortController,fetch:async(url,init)=>{
  fetchCount++;assert.equal(init.headers.Authorization,'Bearer offline-read-only-replay');
  assert.ok(init.signal);assert.equal(init.cache,'no-store');return transport(url,init);
}});
const parent=document.createElement('div');document.body.appendChild(parent);let root=createRoot(parent);
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
const render=async(which,row)=>React.act(async()=>{root.render(React.createElement(component[which],{href:href(row),title:row.source.title,userId:account.user.id},row.source.title));await tick();});
const toggle=async open=>React.act(async()=>{parent.querySelector('details').open=open;await tick();});
const click=async()=>React.act(async()=>{parent.querySelector('a').dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));await tick();});
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
let checks=0;
try{
  await render('ManualSourceFrame',first);assert.equal(fetchCount,0);
  await toggle(true);assert.equal(parent.querySelector('iframe').src,signed(first));checks++;
  const pending=defer();transport=async url=>{await pending.promise;return responseFor(url);};
  await render('ManualSourceFrame',second);
  assert.equal(parent.querySelector('iframe'),null,'The previous manual must disappear immediately.');
  await React.act(async()=>{pending.resolve();await tick();});
  assert.equal(parent.querySelector('iframe').src,signed(second));checks++;
  transport=async url=>responseFor(url);
  const before=fetchCount;await toggle(false);await toggle(true);
  assert.equal(fetchCount,before+1,'Reopening must renew the URL.');checks++;
  await React.act(async()=>{session=null;authListener('SIGNED_OUT',null);await tick();});
  assert.equal(parent.querySelector('iframe'),null);assert.match(parent.textContent,/account changed/);checks++;
  session=activeSession;await toggle(false);
  const signedOut=defer();transport=async url=>{await signedOut.promise;return responseFor(url);};
  await toggle(true);session=null;
  await React.act(async()=>{signedOut.resolve();await tick();});
  assert.equal(parent.querySelector('iframe'),null);assert.match(parent.textContent,/account changed/);checks++;
  session=activeSession;transport=async()=>Response.json({error:'The original source could not be checked. Retry opening it.'},{status:503});
  await render('default',first);await click();
  assert.ok(popups.at(-1).closed);assert.match(parent.textContent,/could not be checked/);checks++;
  transport=async url=>responseFor(url);await click();
  assert.equal(popups.at(-1).url,signed(first));assert.equal(parent.querySelector('[role=alert]'),null);checks++;
  popupBlocked=true;const previous=fetchCount;await click();assert.equal(fetchCount,previous);assert.match(parent.textContent,/Allow this source window/);checks++;
  popupBlocked=false;const abandoned=defer();transport=async url=>{await abandoned.promise;return responseFor(url);};
  await click();const loading=popups.at(-1);
  await React.act(async()=>{root.unmount();await tick();});
  assert.ok(loading.closed);assert.equal(loading.url,'about:blank');
  await React.act(async()=>{abandoned.resolve();await tick();});
  assert.equal(loading.url,'about:blank');checks++;
  root=createRoot(parent);transport=async url=>responseFor(url);
  await render('default',first);await click();const opened=popups.at(-1);
  await React.act(async()=>{root.unmount();await tick();});
  assert.equal(opened.closed,false,'An already opened original stays available after leaving the guide.');checks++;
  console.log(JSON.stringify({validated:true,actualManuals:2,checks,sourceRequests:fetchCount,externalRequests:0,liveWrites:0}));
}finally{dom.window.close();}
