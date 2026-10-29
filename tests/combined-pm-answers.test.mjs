import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const catalog=JSON.parse(readFileSync('src/lib/pm/room-source-items.json','utf8'));
test('room source controls distinguish every printed item, including safe, carpet and sprinkler',()=>{
 assert.equal(Object.keys(catalog).length,102);
 assert.match(catalog.M37.label,/Safe/);assert.match(catalog.R37.label,/Carpet/);assert.match(catalog.M39.label,/Heads/);assert.equal(catalog.M38,undefined);
 const page=readFileSync('src/app/engineering/preventive-maintenance/page.tsx','utf8');assert.match(page,/Historically completed/);assert.match(page,/historicalCompleted=\{!!activeHistory\}/);
 assert.match(readFileSync('src/components/PmAnswerControls.tsx','utf8'),/Completed historically · condition unrecorded/);
});
test('historical answers preserve completion/date, reject conflicts atomically and replay idempotently',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table cmpri_room_pm_history(hotel_id uuid,room text,period_start date,completed_on date,source_id text,primary key(hotel_id,room,period_start));
 create function cmpri_invalidate(uuid,text,text) returns void language sql as $$select$$;
 insert into cmpri_room_pm_history values('00000000-0000-4000-8000-000000000001','410','2026-01-01','2026-03-04','cmpri-room-pm-2026-scott-reconciled-20261028');`);
 await db.exec(readFileSync('supabase/migrations/20261029074000_pm_historical_item_answers.sql','utf8'));
 const row={room:'410',periodStart:'2026-01-01',completedOn:'2026-03-04',answers:{'room-pm-scan-m37':{value:'follow-up',sourcePage:130,evidence:'PM Scan.pdf p130 Q1 M37: /'}}};
 const apply=rows=>db.query('select cmpri_import_room_pm_answers($1,$2,$3) n',['00000000-0000-4000-8000-000000000001',JSON.stringify(rows),'00000000-0000-4000-8000-000000000002']);
 assert.equal((await apply([row])).rows[0].n,1);assert.equal((await apply([row])).rows[0].n,0);
 await assert.rejects(apply([{...row,completedOn:'2026-03-05'}]),/identity\/date conflict/);
 await assert.rejects(apply([{...row,answers:{'room-pm-scan-m37':{...row.answers['room-pm-scan-m37'],value:'complete'}}}]),/answer conflict/);
 const saved=(await db.query('select completed_on::text, item_answers from cmpri_room_pm_history')).rows[0];assert.equal(saved.completed_on,'2026-03-04');assert.equal(saved.item_answers['room-pm-scan-m37'].value,'follow-up');
 }finally{await db.close();}
});
