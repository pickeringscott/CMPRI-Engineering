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
const {projectGuestRoom}=await import('../src/lib/room-guest-reports.ts');

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
 assert.equal(renderToStaticMarkup(React.createElement(Badge,{group:'Unrelated'})),'');
});
