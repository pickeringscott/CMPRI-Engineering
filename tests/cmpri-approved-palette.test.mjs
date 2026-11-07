import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {headerActionStyle,modalThemeStyle,modalTitleStyle,modalActionForRoute,modalDisplayTitle} from '../src/lib/ui/header-palette.ts';
test('every action retains the actual approved Coral Glow mapping, including numbered Feedback labels',()=>{
 const html=readFileSync('.bridge/ChatGPT Errors/CMPRI-selected-tabbed-pills (2).html','utf8');
 const inventory=JSON.parse(html.match(/const inventories=(\{[^\n]+\});/)[1]);const palettes=JSON.parse(html.match(/const previewPalettes=(\[[^\n]+\]);/)[1]);
 const names=[...new Set(Object.values(inventory).flatMap(groups=>groups.flatMap(g=>g.slice(1))))],colors=palettes[5][1];
 for(const name of names){
  if(name==='Sign Out')continue;
  const hex=name.includes('Maintenance')?'#00D492':colors[names.indexOf(name)%colors.length];const rgb=hex.match(/[a-f0-9]{2}/gi).map(x=>parseInt(x,16));
  assert.equal(headerActionStyle(name)['--action-rgb'],rgb.join(','),name);
  if(name==='Hours Tracker')continue; // Approved standalone 07 Eucalyptus modal scheme.
  const theme=modalThemeStyle(name);assert.equal(theme['--cmpri-modal-base'],'#0f172a');assert.equal(theme['--cmpri-modal-text'],headerActionStyle(name).color);assert.equal(theme['--cmpri-outline'],`rgba(${rgb},.42)`);assert.equal(theme['--cmpri-scroll-thumb'],`rgba(${rgb},.28)`);assert.equal(modalTitleStyle(name).backgroundColor,headerActionStyle(name)['background-color']);
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
