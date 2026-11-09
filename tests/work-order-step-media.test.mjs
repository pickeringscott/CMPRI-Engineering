import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import {sourceSemantics} from '../src/lib/work-orders/source-semantics.ts';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://cmpri.test'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../src/components/WorkOrderStepMedia.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const descriptor={id:'media-'+ 'a'.repeat(64),stepLabel:'Inspect drain hose',sourcePage:4,caption:'Figure 1: drain path',width:320,height:180};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

function harness(options={}){
  let desktop=options.desktop||false,authId='user-a',authCallback;
  const mediaListeners=new Set(),requests=[],created=[],revoked=[],adaptations=[],paletteObservers=[];
  let paletteColor='rgb(25, 27, 36)';
  class MutationObserver {constructor(callback){this.callback=callback;paletteObservers.push(this);}observe(){}disconnect(){this.disconnected=true;}}
  window.matchMedia=()=>({matches:desktop,addEventListener:(_name,callback)=>mediaListeners.add(callback),removeEventListener:(_name,callback)=>mediaListeners.delete(callback)});
  const nativeURL=URL;
  class MediaURL extends nativeURL {static createObjectURL(blob){const url='blob:authorized-'+(created.length+1);created.push({url,blob});return url;}static revokeObjectURL(url){revoked.push(url);}}
  const reply=(type='image/png',body=new Blob(['fictional PNG bytes'],{type}))=>({ok:true,status:200,headers:new Headers({'content-type':type}),blob:async()=>body});
  const exports={};
  vm.runInNewContext(code,{exports,Error,window,URL:MediaURL,URLSearchParams,AbortController,queueMicrotask,MutationObserver,getComputedStyle:()=>({backgroundColor:paletteColor,color:'rgb(240, 241, 246)'}),
    fetch:async(url,init)=>{requests.push({url,init});return options.fetch?options.fetch(url,init):reply();},
    require(name){
      if(name==='react'||name==='react/jsx-runtime')return require(name);
      if(name==='@/lib/work-orders/source-semantics')return {sourceSemantics};
      if(name==='@/lib/work-orders/diagram-theme')return {themeSourceDiagramBlob:async(blob,host,text)=>{adaptations.push({blob,host,text});return {blob,adapted:true};}};
      if(name==='@/components/WorkOrderDiagramViewer')return {default:({imageUrl,title,onClose})=>React.createElement('div',{role:'dialog','aria-label':title},React.createElement('img',{src:imageUrl,alt:title}),React.createElement('button',{onClick:onClose},'Close diagram'))};
      if(name==='@/lib/supabase/client')return {getValidSession:async()=>authId?{access_token:'synthetic',user:{id:authId}}:null,createClient:()=>({auth:{onAuthStateChange(callback){authCallback=callback;return {data:{subscription:{unsubscribe(){}}}};}}})};
      throw Error(name);
    },
  });
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  let props={media:[descriptor],assetId:'asset-a',sourceSha256:'b'.repeat(64),userId:'user-a',contextIdentity:'issue/source-a',...options.props};
  const render=async(next={})=>{props={...props,...next};await React.act(async()=>root.render(React.createElement(exports.default,props)));};
  const click=async element=>React.act(async()=>element.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true})));
  const resize=async value=>{desktop=value;await React.act(async()=>{for(const callback of [...mediaListeners])callback();});};
  const auth=async value=>{authId=value;await React.act(async()=>authCallback('SIGNED_OUT',value?{user:{id:value}}:null));};
  const dispose=async()=>{await React.act(async()=>root.unmount());host.remove();};
  const palette=async value=>{paletteColor=value;await React.act(async()=>{for(const observer of paletteObservers)if(!observer.disconnected)observer.callback();});};
  return {host,render,click,resize,auth,dispose,requests,created,revoked,adaptations,palette,reply,setAuth:value=>{authId=value;}};
}

test('mobile shows only a compact image link and fetches the exact approved source on demand',async()=>{
  const h=harness();
  try{
    await h.render();assert.equal(h.requests.length,0);assert.equal(h.host.querySelectorAll('img').length,0);
    assert.equal(h.host.querySelector('section').getAttribute('aria-label'),'Step images and diagrams');
    assert.equal(h.host.querySelector('a').textContent,'Open image/diagram');await h.click(h.host.querySelector('a'));
    assert.equal(h.requests.length,1);const request=h.requests[0],url=new URL(request.url,'https://cmpri.test');
    assert.equal(url.pathname,'/api/maintenance-reference');assert.equal(url.searchParams.get('source'),'asset-upload');
    assert.equal(url.searchParams.get('assetId'),'asset-a');assert.equal(url.searchParams.get('sha256'),'b'.repeat(64));assert.equal(url.searchParams.get('imageId'),descriptor.id);
    assert.equal(request.init.headers.Authorization,'Bearer synthetic');assert.equal(request.init.cache,'no-store');assert.equal(request.init.method,undefined);
    assert.equal(h.host.querySelector('[role=dialog] img').src,'blob:authorized-1');
    assert.equal(h.adaptations.length,1);assert.equal(h.adaptations[0].text,descriptor.stepLabel+'\n'+descriptor.caption);
    assert.equal(h.adaptations[0].host.getAttribute('data-source-media-surface'),'true');
    await h.click(h.host.querySelector('button'));assert.equal(h.host.querySelector('[role=dialog]'),null);
    await h.click(h.host.querySelector('a'));assert.equal(h.requests.length,1,'a second open reuses the same authorized local image');
  }finally{await h.dispose();}
  assert.deepEqual(h.revoked,['blob:authorized-1']);
});

test('desktop renders the real inline image without a mobile link and preserves a single read',async()=>{
  const h=harness({desktop:true});
  try{
    await h.render();assert.equal(h.requests.length,1);assert.equal(h.host.querySelector('img').alt,descriptor.caption);
    assert.equal(h.host.querySelector('img').dataset.diagramAdapted,'true');
    assert.equal(h.host.querySelector('img').src,'blob:authorized-1');assert.ok(!h.host.textContent.includes('Open image/diagram'));
    await h.click(h.host.querySelector('a'));assert.ok(h.host.querySelector('[role=dialog]'));assert.equal(h.requests.length,1);
    await h.click(h.host.querySelector('button'));await h.resize(false);
    assert.equal(h.host.querySelectorAll('img').length,0);assert.equal(h.host.querySelector('a').textContent,'Open image/diagram');
  }finally{await h.dispose();}
});

test('issue or source context changes close the viewer and revoke every old source blob',async()=>{
  const h=harness();
  try{
    await h.render();await h.click(h.host.querySelector('a'));assert.ok(h.host.querySelector('[role=dialog]'));
    await h.render({contextIdentity:'another issue / source',sourceSha256:'c'.repeat(64)});
    assert.equal(h.host.querySelector('[role=dialog]'),null);assert.deepEqual(h.revoked,['blob:authorized-1']);
    await h.click(h.host.querySelector('a'));assert.equal(h.requests.length,2);
    assert.equal(new URL(h.requests[1].url,'https://cmpri.test').searchParams.get('sha256'),'c'.repeat(64));
  }finally{await h.dispose();}
});

test('an old pending image reply cannot populate a new issue or changed source',async()=>{
  const pending=deferred();let reads=0;const h=harness({desktop:true,fetch:()=>++reads===1?pending.promise:h.reply()});
  try{
    await h.render();const oldSignal=h.requests[0].init.signal;
    await h.render({contextIdentity:'current issue/source',sourceSha256:'d'.repeat(64)});
    assert.equal(oldSignal.aborted,true);assert.equal(h.created.length,1);
    await React.act(async()=>pending.resolve(h.reply()));
    assert.equal(h.created.length,1);assert.equal(h.host.querySelector('img').src,'blob:authorized-1');
  }finally{await h.dispose();}
});

test('account changes close open images, revoke blobs, and reject late image replies',async()=>{
  const h=harness();
  try{
    await h.render();await h.click(h.host.querySelector('a'));await h.auth(null);
    assert.equal(h.host.querySelector('[role=dialog]'),null);assert.equal(h.host.querySelector('section'),null);assert.deepEqual(h.revoked,['blob:authorized-1']);
  }finally{await h.dispose();}
  const pending=deferred(),late=harness({desktop:true,fetch:()=>pending.promise});
  try{
    await late.render();await late.auth('other-user');await React.act(async()=>pending.resolve(late.reply()));
    assert.equal(late.created.length,0);assert.equal(late.host.querySelector('section'),null);
  }finally{await late.dispose();}
});

test('non-image and denied source responses never produce a viewer or an invented replacement',async()=>{
  for(const reply of [()=>({ok:false,status:409,json:async()=>({error:'The attached source changed.'})}),()=>({ok:true,status:200,headers:new Headers({'content-type':'text/html'}),blob:async()=>new Blob(['unrelated'])})]){
    const h=harness({fetch:reply});
    try{
      await h.render();await h.click(h.host.querySelector('a'));
      assert.equal(h.host.querySelector('[role=dialog]'),null);assert.equal(h.created.length,0);assert.ok(h.host.querySelector('[role=status]'));
      assert.equal(h.requests.length,1,'there is no catalog, external image, or AI fallback');
    }finally{await h.dispose();}
  }
});

test('the most recently opened diagram wins when two source image responses arrive out of order',async()=>{
  const first=deferred(),second=deferred();let reads=0;
  const h=harness({props:{media:[descriptor,{...descriptor,id:'media-'+ 'c'.repeat(64),caption:'Figure 2: fill path'}]},fetch:()=>++reads===1?first.promise:second.promise});
  try{
    await h.render();const links=h.host.querySelectorAll('a');await h.click(links[0]);await h.click(links[1]);
    await React.act(async()=>second.resolve(h.reply()));assert.equal(h.host.querySelector('[role=dialog]').getAttribute('aria-label'),'Figure 2: fill path');
    await React.act(async()=>first.resolve(h.reply()));assert.equal(h.host.querySelector('[role=dialog]').getAttribute('aria-label'),'Figure 2: fill path');
  }finally{await h.dispose();}
});

test('an empty-to-media step observes host palette changes and discards its previous viewer and display blob',async()=>{
  const h=harness({props:{media:[]}});
  try{
    await h.render();assert.equal(h.host.querySelector('[data-source-media-surface]'),null);
    await h.render({media:[descriptor]});await h.click(h.host.querySelector('a'));
    assert.ok(h.host.querySelector('[role=dialog]'));assert.equal(h.created.length,1);
    await h.palette('rgb(23, 28, 35)');
    assert.equal(h.host.querySelector('[role=dialog]'),null);assert.deepEqual(h.revoked,['blob:authorized-1']);
    assert.equal(h.requests.length,1,'mobile does not eagerly refetch during a palette change');
    await h.click(h.host.querySelector('a'));assert.equal(h.requests.length,2);assert.equal(h.created.length,2);
    assert.equal(h.adaptations.length,2,'a reopened image is adapted to the current host palette');
  }finally{await h.dispose();}
});
