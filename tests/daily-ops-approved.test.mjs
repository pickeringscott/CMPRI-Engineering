import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGuestReport,roomsFromGuestReports,projectGuestRoom,validateGuestReportBatch} from '../src/lib/room-guest-reports.ts';
import {isBigTenGroup,isRailwayCnGuestName} from '../src/lib/room-operations.ts';
const parse=(kind,csv)=>parseGuestReport(`${kind}_CMPRI_2026-11-05_10-00-00.csv`,csv);
const guests=parse('In House Guest List Details','ROOM NUMBER,GUEST NAME,ARRIVAL,DEPARTURE,NIGHTS,GROUP NAME\n101,Jane Doe,2026-11-04,2026-11-05,1,Big Ten Team');
test('departure alias reaches row lookup and departure time',()=>{
 const departures=parse('Housekeeping Departures','ROOM #,GUEST NAME,DEPARTURE TIME\n101,Jane Doe,13:00');
 assert.equal(departures.rows[0]['ROOM NUMBER'],'101');
 assert.equal(roomsFromGuestReports({guests,departures},['101'],[])[0].checkout_time,'13:00:00');
});
test('alias collisions and duplicate headers rejected before row mapping',()=>{
 for(const header of ['ROOM #,ROOM NUMBER','ROOM #,ROOM #','ROOM NUMBER,ROOM NUMBER'])assert.throws(()=>parse('Housekeeping Departures',`${header},GUEST NAME\n101,102,Jane Doe`),/duplicate headers/);
 assert.throws(()=>parse('Housekeeping Arrivals','ROOM #,GUEST NAME\n101,Jane Doe'),/missing ROOM NUMBER/);
});
test('arrival same guest deduplicates despite comments; distinct guest conflicts remain',()=>{
 const csv='ROOM NUMBER,GUEST NAME,RESERVATION COMMENTS,GROUP NAME\n101,Sam Guest,first,Big Ten Visitors\n101,Sam Guest,second,Big Ten Visitors';
 const arrivals=parse('Housekeeping Arrivals',csv);
 const room=roomsFromGuestReports({guests,arrivals},['101'],[])[0];
 assert.equal(room.incoming_name,'Sam Guest');assert.equal(room.incoming_company,'Big Ten Visitors');
 assert.throws(()=>roomsFromGuestReports({guests,arrivals:parse('Housekeeping Arrivals',csv+'\n101,Other Guest,third,Other')},['101'],[]),/multiple incoming/);
 const projected=projectGuestRoom(room,new Date('2026-11-05T17:00:00Z'),'UTC');
 assert.equal(projected.guest_name,'Sam Guest');assert.equal(projected.company,'Big Ten Visitors');assert.equal(projected.incoming_company,'');
});
test('guest-list duplicate protection remains',()=>assert.throws(()=>roomsFromGuestReports({guests:{...guests,rows:[...guests.rows,...guests.rows]}},['101'],[]),/duplicated/));
test('Big Ten group matching and existing CN matching',()=>{
 for(const group of ['Big Ten','2026 BIG TEN Visitors','Big   Ten Team'])assert.equal(isBigTenGroup(group),true);
 for(const group of ['',null,'Other Group','Big Tennis'])assert.equal(isBigTenGroup(group),group==='Big Tennis');
 assert.equal(isRailwayCnGuestName('Railway/CN crew'),true);
});
test('badges render beside both guest names with proportional sizing; CN stays in its existing position',async()=>{
 const {readFileSync}=await import('node:fs');
 const ts=await import('typescript');const React=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const source=readFileSync(new URL('../src/app/engineering/room-operations/page.tsx',import.meta.url),'utf8');
 const badge=source.slice(source.indexOf('function BigTenBadge('),source.indexOf('function RoomIdentity('));
 const js=ts.default.transpileModule(badge,{compilerOptions:{jsx:ts.default.JsxEmit.React}}).outputText;
 const component=Function('React','Image','isBigTenGroup',js+';return BigTenBadge;')(React,props=>React.createElement('img',props),isBigTenGroup);
 const html=renderToStaticMarkup(React.createElement(component,{group:'Big Ten Team'}));
 assert.match(html,/width="500" height="300"/);assert.match(html,/h-\[27px\] w-auto/);assert.match(html,/object-contain/);
 assert.equal(renderToStaticMarkup(React.createElement(component,{group:'Other'})),'');
 assert.match(source,/row.guest_name\} <BigTenBadge group=\{row.group_name \|\| row.company\}/);
 assert.match(source,/row.incoming_name \|\| "Name unavailable"\} <BigTenBadge group=\{row.incoming_company\}/);
 assert.match(source,/src="\/railway-cn-logo.png"/);
});

test('combined synthetic batch validates alias, duplicate arrivals, and current/incoming group transitions',()=>{
 const departures=parse('Housekeeping Departures','ROOM #,GUEST NAME,DEPARTURE TIME\n101,Jane Doe,13:00');
 const arrivals=parse('Housekeeping Arrivals','ROOM NUMBER,GUEST NAME,GROUP NAME,RESERVATION COMMENTS\n101,Sam Guest,Big Ten Visitors,first\n101,Sam Guest,Big Ten Visitors,second');
 const batch=validateGuestReportBatch([guests,departures,arrivals],{},'2026-11-05');
 const [room]=roomsFromGuestReports(batch,['101'],[]);
 assert.equal(room.checkout_time,'13:00:00');
 assert.equal(room.guest_name,'Jane Doe');assert.equal(isBigTenGroup(room.group_name),true);
 assert.equal(room.incoming_name,'Sam Guest');assert.equal(isBigTenGroup(room.incoming_company),true);
 const after=projectGuestRoom(room,new Date('2026-11-05T17:00:00Z'),'UTC');
 assert.equal(after.guest_name,'Sam Guest');assert.equal(isBigTenGroup(after.group_name),true);
 assert.equal(after.incoming_name,'');
});
