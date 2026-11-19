import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {loadTs} from './helpers/load-ts.mjs';

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
function property(node,name) {
  return node.properties.find(item=>item.name?.getText(file).replaceAll('"','')===name)?.initializer;
}
const path=vm.runInNewContext(declaration('WEATHER_PREVIEW_PATH').getText(file));
const operations=declaration('launcherGroups').elements.find(group=>property(group,'label')?.text==='Operations');
assert.ok(operations,'Weather belongs in the existing Operations group');
const weather=property(operations,'items').elements.find(item=>item.getText(file).includes('label: "Weather"'));
assert.ok(weather,'Missing native Operations Weather launcher');
function launcher(flag,canViewDashboard) {
  return vm.runInNewContext('('+weather.getText(file)+')',{
    WEATHER_PREVIEW_PATH:path,
    process:{env:{NEXT_PUBLIC_CMPRI_WEATHER_PREVIEW:flag}},
    session:{capabilities:canViewDashboard?['view_dashboard']:[]},
    hasCapability:(session,capability)=>session.capabilities.includes(capability),
  });
}

test('the compiled Weather flag is enabled only for preview builds or local development',()=>{
  for(const [VERCEL_ENV,NODE_ENV,expected] of [
    ['preview','production','1'],['production','production','0'],
    ['development','development','1'],[undefined,'development','1'],
    [undefined,'production','0'],['development','production','0'],
  ]) {
    const config=loadTs('next.config.ts',{}, {process:{env:{VERCEL_ENV,NODE_ENV}}}).default;
    assert.equal(config.env.NEXT_PUBLIC_CMPRI_WEATHER_PREVIEW,expected,`${VERCEL_ENV}/${NODE_ENV}`);
  }
});

test('native Operations exposes Weather only with the review flag and dashboard permission',()=>{
  for(const flag of ['0',undefined])assert.equal(launcher(flag,true),false);
  assert.equal(launcher('1',false),false);
  const action=launcher('1',true);
  assert.equal(action.label,'Weather');
  assert.equal(action.key,path);
  assert.equal(action.href,path+'?weather=open');
  assert.equal(action.accent,'bg-amber-400');
  assert.equal(action.preferred.width,1280);
  assert.equal(action.preferred.height,800);
});

test('Weather uses the existing same-origin desktop frame route and host window sizing',()=>{
  const windows=loadTs('src/lib/ui/desktop-windows.ts',{}, {URL});
  const action=launcher('1',true), origin='https://branch.example';
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
