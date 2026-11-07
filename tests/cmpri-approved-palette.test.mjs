import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {headerActionStyle as rawHeader,modalThemeStyle as rawTheme,modalTitleStyle as rawTitle,modalActionForRoute,modalDisplayTitle} from '../src/lib/ui/header-palette.ts';
import {sitePaletteTokens} from '../src/lib/ui/site-palette-defaults.ts';
function resolveTokens(value){
 let text=value;
 for(let n=0;n<30;n++){
  const match=/var\(--cmpri-palette-([a-z0-9-]+),/.exec(text);if(!match)return text;
  const start=match.index;let depth=1,end=start+match[0].length;
  for(;end<text.length&&depth;end++){if(text[end]==='(')depth++;if(text[end]===')')depth--;}
  const fallback=text.slice(start+match[0].length,end-1);
  text=text.slice(0,start)+(sitePaletteTokens[match[1]]||fallback)+text.slice(end);
 }
 return text;
}
const resolved=style=>Object.fromEntries(Object.entries(style).map(([key,value])=>[key,resolveTokens(value)]));
const headerActionStyle=name=>resolved(rawHeader(name)),modalThemeStyle=name=>resolved(rawTheme(name)),modalTitleStyle=name=>resolved(rawTitle(name));
test('every action retains the actual approved Coral Glow mapping, including numbered Feedback labels',()=>{
 const html=readFileSync('.bridge/ChatGPT Errors/CMPRI-selected-tabbed-pills (2).html','utf8');
 const inventory=JSON.parse(html.match(/const inventories=(\{[^\n]+\});/)[1]);const palettes=JSON.parse(html.match(/const previewPalettes=(\[[^\n]+\]);/)[1]);
 const names=[...new Set(Object.values(inventory).flatMap(groups=>groups.flatMap(g=>g.slice(1))))],colors=palettes[5][1];
 for(const name of names){
  if(name==='Sign Out')continue;
  const hex=name.includes('Maintenance')?'#00D492':colors[names.indexOf(name)%colors.length];const rgb=hex.match(/[a-f0-9]{2}/gi).map(x=>parseInt(x,16));
  assert.equal(headerActionStyle(name)['--action-rgb'],rgb.join(','),name);
  if(name==='Hours Tracker')continue; // Approved standalone 07 Eucalyptus modal scheme.
  const theme=modalThemeStyle(name);assert.equal(theme['--cmpri-modal-base'],'#181818');assert.equal(theme['--cmpri-modal-text'],headerActionStyle(name).color);assert.equal(theme['--cmpri-outline'],`rgba(${rgb},.42)`);assert.equal(theme['--cmpri-scroll-thumb'],`rgba(${rgb},.28)`);assert.equal(modalTitleStyle(name).backgroundColor,headerActionStyle(name)['background-color']);
 }
 assert.deepEqual(headerActionStyle('Feedback (7)'),headerActionStyle('Feedback'));
});

test('approved create and detail palettes resolve consistently for embedded routes and desktop titles',()=>{
 for(const [route,action,rgb,base] of [
  ['/work-orders?embedded=1','Create Work Order','148,180,206','#101319'],
  ['/work-orders/abc?embedded=1','Work Order Detail','162,171,209','#11131a'],
  ['/engineering/hours-tracker?embedded=1','Hours Tracker','142,189,170','#101512'],
 ]){
  assert.equal(modalActionForRoute(route),action);
  const theme=modalThemeStyle(action);
  assert.equal(theme['--cmpri-action-rgb'],rgb);
  assert.equal(theme['--cmpri-modal-base'],base);
  assert.ok(theme['--cmpri-modal-surface'].includes(base));
  assert.ok(modalTitleStyle(action).backgroundColor.includes(rgb));
  assert.equal(modalTitleStyle(action).color,theme['--cmpri-modal-text']);
 }
 assert.equal(modalThemeStyle('Work Order List')['--cmpri-action-rgb'],'243,187,117');
 assert.deepEqual(modalThemeStyle('+ Work Order'),modalThemeStyle('Create Work Order'));
});

test('Manage Locations keeps the approved location palette and labels both hosts consistently',()=>{
 assert.deepEqual(headerActionStyle('Manage Locations'),headerActionStyle('Manage Rooms'));
 assert.equal(modalActionForRoute('/management/rooms?embedded=1'),'Manage Locations');
 assert.equal(modalDisplayTitle('/management/rooms','Manage Rooms'),'Manage Locations');
 assert.equal(modalDisplayTitle('/management/rooms?embedded=1','Rooms'),'Manage Locations');
 assert.equal(modalDisplayTitle('/work-orders','Create Work Order'),'Create Work Order');
});

test('all shared header and modal styles use site palette tokens while defaults remain approved',()=>{
 for(const name of ['Work Order List','Staff Notes','Create Work Order','Work Order Detail','Hours Tracker','Manage Locations','Sign Out']){
  assert.ok(Object.values(rawTheme(name)).some(value=>value.includes('var(--cmpri-palette-')),name);
 }
});
