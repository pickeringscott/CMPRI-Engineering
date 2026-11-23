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

test('the actual weather tile mounts on a desktop-sized touch device and tracks the mobile width boundary',async()=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.invalid/engineering',pretendToBeVisual:true});
  const prior=Object.fromEntries(['window','document','HTMLElement','IS_REACT_ACT_ENVIRONMENT'].map(key=>[key,globalThis[key]]));
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
  let width=1920,opened=0;
  const queries=[],reads=[],listeners=new Set();
  dom.window.matchMedia=value=>{
    queries.push(value);
    return {get matches(){return width>=Number(value.match(/min-width:\s*(\d+)px/)?.[1]||0)&&!value.includes('hover: hover');},
      addEventListener:(_name,listener)=>listeners.add(listener),removeEventListener:(_name,listener)=>listeners.delete(listener)};
  };
  const Component=loadTs('src/components/desktop/WeatherUtilities.tsx',{
    react:React,'react/jsx-runtime':jsx,'next/script':{default:()=>null},
    '@/components/UiLanguageProvider':{useUiLanguage:()=>({t:value=>value})},
    './weather-utilities.module.css':{default:new Proxy({},{get:(_target,key)=>String(key)})},
  },{window:dom.window,document:dom.window.document,AbortController,
    fetch:async url=>{reads.push(url);return Response.json({dashboard:{current:46,high:59,low:38,precipitation:10,wind:13,bearing:300,condition:'Cloudy',icon:null,isDaytime:false,moonAngle:42}});}}).default;
  const {createRoot}=await import('react-dom/client');
  const root=createRoot(dom.window.document.getElementById('root'));
  const dial=()=>dom.window.document.querySelector('[data-cmpri-weather-dial]');
  try {
    await act(async()=>{root.render(React.createElement(Component,{onOpen:()=>opened++},'Utilities'));await new Promise(resolve=>setImmediate(resolve));});
    assert.ok(dial(),'A 1920px touch device must mount the weather dial');
    assert.match(dial().getAttribute('aria-label'),/46° · Cloudy/);
    assert.deepEqual(reads,['/api/weather-preview?part=dashboard']);
    assert.ok(queries.every(query=>!query.includes('hover')));
    await act(async()=>dial().click());assert.equal(opened,1);
    await act(async()=>{width=1024;for(const listener of listeners)listener();});assert.ok(dial());
    await act(async()=>{width=700;for(const listener of listeners)listener();});assert.equal(dial(),null);
    await act(async()=>{width=701;for(const listener of listeners)listener();await new Promise(resolve=>setImmediate(resolve));});assert.ok(dial());
    await act(async()=>root.render(React.createElement(Component,null,'Utilities')));assert.equal(dial(),null,'Native role/launcher denial still omits the tile');
  } finally {
    await act(async()=>root.unmount());dom.window.close();
    for(const [key,value] of Object.entries(prior))if(value===undefined)delete globalThis[key];else globalThis[key]=value;
  }
});
