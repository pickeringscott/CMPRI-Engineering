import './helpers/resolve-ts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import sharp from 'sharp';
const {roomGroupBadge,currentRoomGroupBadges}=await import('../src/lib/room-group-badges.ts');
const {projectGuestRoom,parseGuestReport,roomsFromGuestReports}=await import('../src/lib/room-guest-reports.ts');

test('Flyover matches the observed group label and full brand, never an unrelated guest or company',()=>{
 for(const group of ['FLYOVER STUDIOS','Flyover Film Studios','  flyover  studios  '])assert.equal(roomGroupBadge(group),'flyover-studios');
 for(const group of [null,undefined,'','Flyover','Flyover Studios Catering','Not Flyover Studios','Fly Over Other Studios','FFS',42])assert.equal(roomGroupBadge(group),null);
 assert.equal(roomGroupBadge('Big Ten'),'big-ten');
 assert.deepEqual(currentRoomGroupBadges({guest_name:'Flyover Studios',company:'Unrelated'}),{guest_group_badge:null,incoming_group_badge:null});
});
test('badge follows the effective guest snapshot through checkout, reservation, and arrival',()=>{
 const source={room:'101',guest_name:'Fictional outgoing',company:'FLYOVER STUDIOS',group_name:'',room_status:'Occupied',checkout_date:'2026-11-06',checkout_time:'11:00:00',incoming_name:'Fictional incoming',incoming_company:'Big Ten',incoming_reserved:true,reserved:true,arrival_date:'2026-11-06',arrival_time:'15:00:00'};
 const before=projectGuestRoom(source,new Date('2026-11-06T16:59:00Z'),'America/Chicago');
 assert.deepEqual(currentRoomGroupBadges(before),{guest_group_badge:'flyover-studios',incoming_group_badge:'big-ten'});
 const between=projectGuestRoom(source,new Date('2026-11-06T18:00:00Z'),'America/Chicago');
 assert.deepEqual(currentRoomGroupBadges(between),{guest_group_badge:null,incoming_group_badge:'big-ten'});
 const after=projectGuestRoom(source,new Date('2026-11-06T21:00:00Z'),'America/Chicago');
 assert.deepEqual(currentRoomGroupBadges(after),{guest_group_badge:'big-ten',incoming_group_badge:null});
 assert.deepEqual(currentRoomGroupBadges({company:'FLYOVER STUDIOS',incoming_company:'Big Ten'}),{guest_group_badge:null,incoming_group_badge:null});
 assert.equal(source.guest_name,'Fictional outgoing');
});
test('public badge is the exact supplied AVIF with preserved intrinsic aspect ratio',async()=>{
 const asset=readFileSync(new URL('../public/FFS_Logo6.avif',import.meta.url));
 // SHA-256 verified against dcf7767:.bridge/FFS_Logo6.avif; independent of checkout depth.
 assert.equal(createHash('sha256').update(asset).digest('hex'),'0cfbf929713c34e1ba7542f19caf90ad4eb31fa47e8d65386c15bf4a33444882');
 const {width,height}=await sharp(asset).metadata();assert.equal(width,906);assert.equal(height,644);
});

test('shared renderer labels both groups, preserves dimensions and renders nothing for unknown groups',()=>{
 const loadedModule={exports:{}};
 const source=readFileSync(new URL('../src/components/GuestGroupBadge.tsx',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,{exports:loadedModule.exports,React,require:name=>name==='next/image'?{default:props=>React.createElement('img',props)}:{roomGroupBadge}});
 const Badge=loadedModule.exports.default;
 const flyover=renderToStaticMarkup(React.createElement(Badge,{group:'FLYOVER STUDIOS'}));
 assert.match(flyover,/alt="Flyover Film Studios"/);assert.match(flyover,/width="906" height="644"/);assert.match(flyover,/w-auto/);assert.match(flyover,/FFS_Logo6.avif/);
 assert.match(renderToStaticMarkup(React.createElement(Badge,{badge:'big-ten'})),/alt="Big Ten"/);
 assert.match(renderToStaticMarkup(React.createElement(Badge,{badge:'railway-cn'})),/alt="CN"/);
 assert.match(renderToStaticMarkup(React.createElement(Badge,{group:'CN'})),/railway-cn-logo.png/);
 assert.equal(renderToStaticMarkup(React.createElement(Badge,{group:'Unrelated'})),'');
});

test('CN assignments use imported group columns for current and incoming guests',()=>{
 for (const label of ['CN','CN RAILWAYS','Cn Railway',' Canadian National ','CANADIAN NATIONAL RAILWAY','RAILWAY/CN-NJ8','Railway / CN crew']) assert.equal(roomGroupBadge(label),'railway-cn');
 for (const label of ['CN Other Company','Other Canadian National Supplier','SCN',null,42]) assert.equal(roomGroupBadge(label),null);
 assert.deepEqual(currentRoomGroupBadges({guest_name:'Current Guest',group_name:'CN',incoming_name:'Incoming Guest',incoming_group_name:'CN',incoming_reserved:true}),{guest_group_badge:'railway-cn',incoming_group_badge:'railway-cn'});
 assert.equal(currentRoomGroupBadges({guest_name:'Railway/CN-NJ8'}).guest_group_badge,null);
 assert.equal(currentRoomGroupBadges({guest_name:'Current Guest',group_name:'Other group',company:'CN'}).guest_group_badge,null);
 assert.deepEqual(currentRoomGroupBadges({company:'CN',incoming_company:'CN',incoming_name:'Next Guest',reserved:false}),{guest_group_badge:null,incoming_group_badge:null});
 assert.equal(currentRoomGroupBadges({guest_name:'CN',company:'Other'}).guest_group_badge,null);
});

test('CN badge transfers from incoming to current and clears after checkout',()=>{
 const source={room:'101',guest_name:'Outgoing Guest',group_name:'CN',company:'Other company',room_status:'Occupied',checkout_date:'2026-11-06',checkout_time:'11:00:00',incoming_name:'Incoming Guest',incoming_group_name:'CN',incoming_company:'Other company',incoming_reserved:true,reserved:true,arrival_date:'2026-11-06',arrival_time:'15:00:00',incoming_checkout_date:'2026-11-07',incoming_checkout_time:'11:00:00'};
 const badges=at=>currentRoomGroupBadges(projectGuestRoom(source,new Date(at),'America/Chicago'));
 assert.deepEqual(badges('2026-11-06T16:59:00Z'),{guest_group_badge:'railway-cn',incoming_group_badge:'railway-cn'});
 assert.deepEqual(badges('2026-11-06T18:00:00Z'),{guest_group_badge:null,incoming_group_badge:'railway-cn'});
 assert.deepEqual(badges('2026-11-06T21:00:00Z'),{guest_group_badge:'railway-cn',incoming_group_badge:null});
 assert.deepEqual(badges('2026-11-07T18:00:00Z'),{guest_group_badge:null,incoming_group_badge:null});
});

test('in-house Group Name drives CN for ordinary guest names and repairs preserved report projections',()=>{
 const report=parseGuestReport('In House Guest List Details_CMPRI_2026-11-08_08-00-00.csv',
  'ROOM NUMBER,GUEST NAME,ARRIVAL,DEPARTURE,NIGHTS,COMPANY,GROUP NAME\n101,"Guest, Sample",2026-11-07,2026-11-09,2,Other Company,CN');
 const rows=roomsFromGuestReports({guests:report},['101'],[]);
 assert.equal(rows[0].group_name,'CN');
 assert.equal(currentRoomGroupBadges(rows[0]).guest_group_badge,'railway-cn');
 const old={...rows[0],group_name:''};
 const recovered=projectGuestRoom(old,new Date('2026-11-08T15:00:00Z'),'America/Chicago',{guests:report});
 assert.equal(currentRoomGroupBadges(recovered).guest_group_badge,'railway-cn');
 assert.equal(old.group_name,'');
 const corrected={...report,rows:report.rows.map(r=>({...r,'GROUP NAME':''}))};
 const cleared=projectGuestRoom({...rows[0],guest_name:'Sample Guest'},new Date('2026-11-08T15:00:00Z'),'America/Chicago',{guests:corrected});
 assert.equal(currentRoomGroupBadges(cleared).guest_group_badge,null);
});
test('shared modal guest indicators show CN immediately after the name without requiring cn_room',()=>{
 const source=readFileSync(new URL('../src/components/WorkOrderGuestIndicators.tsx',import.meta.url),'utf8');
 const exports={};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,{
  exports,React,require(name){
   if(name==='./GuestGroupBadge')return {default:({badge})=>badge?React.createElement('img',{alt:badge}):null};
   if(name==='./LoyaltyBadge')return {default:({tier})=>tier?React.createElement('span',null,tier):null};
   if(name==='@/lib/loyalty-tier')return {loyaltyTier:value=>value};
   throw Error(name);
  }
 });
 const html=renderToStaticMarkup(React.createElement(exports.default,{guest:{guest_name:'Sample Guest',guest_group_badge:'railway-cn',loyalty_tier:'Gold'}}));
 assert.match(html,/Sample Guest<\/span><img alt="railway-cn"\/><span>Gold/);
});

test('observed in-house CN RAILWAYS group assigns the badge regardless of the guest name',()=>{
 assert.equal(currentRoomGroupBadges({guest_name:'Cn Railway',group_name:'CN RAILWAYS'}).guest_group_badge,'railway-cn');
 assert.equal(currentRoomGroupBadges({guest_name:'Another Guest',group_name:'CN RAILWAYS'}).guest_group_badge,'railway-cn');
 assert.equal(currentRoomGroupBadges({guest_name:'Cn Railway',group_name:''}).guest_group_badge,null);
});
