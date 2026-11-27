import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {loadTs} from './helpers/load-ts.mjs';
import React, {act} from 'react';
import * as jsx from 'react/jsx-runtime';
import {JSDOM} from 'jsdom';

const source=readFileSync(new URL('../src/app/engineering/page.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function declaration(name) {
  let found;
  function visit(node) {
    if(ts.isVariableDeclaration(node)&&node.name.getText(file)===name)found=node.initializer;
    if(!found)ts.forEachChild(node,visit);
  }
  visit(file);
  assert.ok(found,`Missing dashboard declaration: ${name}`);
  return found;
}
const roles=loadTs('src/lib/server/roles.ts');
const menu=loadTs('src/lib/dashboard/menu-groups.ts',{'../server/roles':roles});
const {canOpenWeather}=loadTs('src/lib/dashboard/menu-access.ts');
const path=vm.runInNewContext(declaration('WEATHER_PREVIEW_PATH').getText(file),{WEATHER_MENU_PATH:menu.WEATHER_MENU_PATH});
const weather=declaration('launchers').elements.find(item=>item.getText(file).includes('label: "Weather"'));
assert.ok(weather,'Missing native Weather launcher');
function launcher(flag,role) {
  return vm.runInNewContext('('+weather.getText(file)+')',{
    WEATHER_PREVIEW_PATH:path,
    process:{env:{NEXT_PUBLIC_CMPRI_WEATHER_PREVIEW:flag}},
    session:{user:{role}},
    canOpenWeather,
  });
}

test('the compiled Weather launcher is enabled in production, previews and local builds',()=>{
  for(const [VERCEL_ENV,NODE_ENV,expected] of [
    ['preview','production','1'],['production','production','1'],
    ['development','development','1'],[undefined,'development','1'],
    [undefined,'production','1'],['development','production','1'],
  ]) {
    const config=loadTs('next.config.ts',{}, {process:{env:{VERCEL_ENV,NODE_ENV}}}).default;
    assert.equal(config.env.NEXT_PUBLIC_CMPRI_WEATHER_PREVIEW,expected,`${VERCEL_ENV}/${NODE_ENV}`);
    assert.equal(config.env.NEXT_PUBLIC_CMPRI_PREVIEW,VERCEL_ENV==='preview'?'1':'0');
  }
});

test('Weather stays in Safety & Logs for Front Desk and Lead Housekeeper',()=>{
  for(const flag of ['0',undefined])assert.equal(launcher(flag,'chief_engineer'),false);
  assert.equal(launcher('1','unknown'),false);
  for(const role of ['assistant_manager','front_desk_manager'])assert.equal(launcher('1',role),false);
  const action=launcher('1','chief_engineer');
  assert.equal(action.label,'Weather');
  assert.equal(action.key,path);
  assert.equal(action.href,path+'?weather=open');
  assert.equal(action.accent,'bg-amber-400');
  assert.equal(action.preferred.width,1280);
  assert.equal(action.preferred.height,800);
  for(const role of ['front_desk','housekeeping']) {
    const groups=menu.dashboardMenuGroups(role,[launcher('1',role),{key:'sign-out',label:'Sign Out'},{key:'/engineering/pool-log',label:'Pool Log'}]);
    assert.deepEqual(Array.from(groups,group=>group.label),['Rooms & Reports','Safety & Logs','Account']);
    assert.deepEqual(Array.from(groups[1].items,item=>item.label),['Weather']);
    assert.equal(groups[2].centered,true);
  }
});

test('Weather uses the existing same-origin desktop frame route and host window sizing',()=>{
  const windows=loadTs('src/lib/ui/desktop-windows.ts',{}, {URL});
  const action=launcher('1','chief_engineer'), origin='https://branch.example';
  assert.equal(windows.isDesktopRoute(action.href,origin),true);
  assert.equal(windows.desktopWindowKeyForHref(action.href,origin),path);
  const frame=new URL(windows.desktopFrameHref(action.href,'weather-review-token',origin),origin);
  assert.equal(frame.pathname,path);
  assert.equal(frame.searchParams.get('weather'),'open');
  assert.equal(frame.searchParams.get('embedded'),'1');
  assert.equal(frame.searchParams.get('modalToken'),'weather-review-token');
  const routes=vm.runInNewContext('('+declaration('ROUTE_WINDOWS').getText(file)+')',{WEATHER_PREVIEW_PATH:path});
  assert.equal(routes[path].title,'Weather');
  assert.equal(routes[path].preferred.width,action.preferred.width);
  assert.equal(routes[path].preferred.height,action.preferred.height);
});

test('the weather dial and feed only run at desktop widths without removing the other controls',async()=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.invalid/engineering',pretendToBeVisual:true});
  const prior=Object.fromEntries(['window','document','HTMLElement','IS_REACT_ACT_ENVIRONMENT'].map(key=>[key,globalThis[key]]));
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
  let opened=0;
  const reads=[];
  let width=390;
  const viewport=new dom.window.EventTarget();
  Object.defineProperty(viewport,'matches',{get:()=>width>=701});
  dom.window.matchMedia=query=>{assert.equal(query,'(min-width: 701px)');return viewport;};
  const resize=async nextWidth=>{
    width=nextWidth;
    await act(async()=>{viewport.dispatchEvent(new dom.window.Event('change'));await new Promise(resolve=>setImmediate(resolve));});
  };
  const Component=loadTs('src/components/desktop/WeatherUtilities.tsx',{
    react:React,'react/jsx-runtime':jsx,'next/script':{default:()=>null},
    '@/components/UiLanguageProvider':{useUiLanguage:()=>({t:value=>value})},
    './WeatherDialScene':{default:()=>null},
    './WeatherWidgetRadar':{default:({children})=>children},
    './weather-utilities.module.css':{default:new Proxy({},{get:(_target,key)=>String(key)})},
  },{window:dom.window,document:dom.window.document,AbortController,
    fetch:async url=>{reads.push(url);return Response.json({dashboard:{current:46,high:59,low:38,precipitation:10,wind:13,bearing:300,condition:'Cloudy',icon:null,isDaytime:false,moonAngle:42}});}}).default;
  const {createRoot}=await import('react-dom/client');
  const root=createRoot(dom.window.document.getElementById('root'));
  const dial=()=>dom.window.document.querySelector('[data-cmpri-weather-dial]');
  try {
    await act(async()=>{root.render(React.createElement(Component,{onOpen:()=>opened++},'Utilities'));await new Promise(resolve=>setImmediate(resolve));});
    assert.equal(dial(),null,'The initially narrow dashboard must omit the entire weather dial');
    assert.deepEqual(reads,[]);
    assert.equal(dom.window.document.getElementById('root').textContent,'Utilities');
    await resize(701);
    assert.ok(dial(),'The desktop weather dial appears at the dashboard breakpoint');
    assert.match(dial().getAttribute('aria-label'),/46° · Cloudy/);
    assert.deepEqual(reads,['/api/weather-preview?part=dashboard']);
    await act(async()=>dial().click());assert.equal(opened,1);
    for (const desktopWidth of [1024,1920]) {
      await resize(desktopWidth);
      assert.ok(dial());
    }
    assert.deepEqual(reads,['/api/weather-preview?part=dashboard']);
    for (const mobileWidth of [700,390]) {
      await resize(mobileWidth);
      assert.equal(dial(),null);
    }
    assert.equal(reads.length,1,'Removing the widget never starts a mobile feed');
    await resize(1440);
    assert.ok(dial());
    assert.equal(reads.length,2);
    await act(async()=>root.render(React.createElement(Component,null,'Utilities')));assert.equal(dial(),null,'Native role/launcher denial still omits the tile');
  } finally {
    await act(async()=>root.unmount());dom.window.close();
    for(const [key,value] of Object.entries(prior))if(value===undefined)delete globalThis[key];else globalThis[key]=value;
  }
});
