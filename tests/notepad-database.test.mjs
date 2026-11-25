import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { legacyStaffNotes } from '../src/lib/server/notepad-store.ts';
const owner='00000000-0000-4000-8000-000000000001',tech='00000000-0000-4000-8000-000000000002',manager='00000000-0000-4000-8000-000000000003',hotel='00000000-0000-4000-8000-000000000004',other='00000000-0000-4000-8000-000000000005',id='00000000-0000-4000-8000-000000000006';
const change=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const doc={title:'Project',audience:{all:false,roles:['technician'],people:[]},content:'<p>Text</p>',priority:'High',fontSize:16,fontFamily:'Arial',titleFontFamily:'Georgia',ink:[],itemThreads:{},attachments:[]};
async function fixture(){const db=new PGlite();await db.exec(`set timezone='UTC';create role anon;create role authenticated;create role service_role bypassrls;create schema cmpri_private;grant usage on schema cmpri_private to service_role;
create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;
create table profiles(id uuid primary key,active boolean,role text,secondary_roles text[]);create table hotels(id uuid primary key);create table hotel_members(hotel_id uuid,user_id uuid,active boolean);
create table work_orders(id uuid,hotel_id uuid,status text,created_at timestamptz);
create table cmpri_general_notes(hotel_id uuid,user_id uuid,id uuid,document jsonb,updated_at timestamptz,deleted_at timestamptz,revision bigint not null default 1);
create table cmpri_staff_notes(hotel_id uuid,id uuid,author_user_id uuid,author_name text,created_at timestamptz,parent_id uuid,body text not null default '');
grant select on profiles,hotel_members,cmpri_general_notes,cmpri_staff_notes to service_role;
insert into profiles values('${owner}',true,'Chief Engineer','{}'),('${tech}',true,'Maintenance Technician','{}'),('${manager}',true,'General Manager','{}');insert into hotels values('${hotel}'),('${other}');insert into hotel_members values('${hotel}','${owner}',true),('${hotel}','${tech}',true),('${hotel}','${manager}',true);`);
// Apply the real signal table, RLS and trigger function, then its latest topic
// constraint. Only unrelated business-table triggers are omitted from this fixture.
const signals=readFileSync('supabase/migrations/20261106133302_event_driven_resources.sql','utf8');await db.exec(signals.slice(0,signals.indexOf('create trigger resource_orders'))+'\ncommit;');
const modalSignals=readFileSync('supabase/migrations/20261106133511_modal_resource_events.sql','utf8');await db.exec(modalSignals.slice(0,modalSignals.indexOf('create trigger resource_assets_and_manuals'))+'\ncommit;');
await db.exec('alter table profiles add column full_name text');
await db.query('update profiles set full_name=$1 where id=$2',['Avery Reed',owner]);
await db.query('update profiles set full_name=$1 where id=$2',['Morgan Ellis',tech]);
for(const suffix of ['_notepad_shared_documents.sql','_notepad_edit_history.sql']){
 const name=readdirSync('supabase/migrations').find(n=>n.endsWith(suffix));await db.exec(readFileSync('supabase/migrations/'+name,'utf8'));
}
return db}
async function save(db,actor,expected,mutation,document=doc,source=null,noteId=id,property=hotel,legacyVersion=undefined){if(legacyVersion===undefined)legacyVersion=source==='general'?'general:1':source==='staff'?(await db.query('select cmpri_private.notepad_staff_version($1,$2) as version',[property,noteId])).rows[0].version:null;return(await db.query('select * from cmpri_save_notepad($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::jsonb,$7::text,$8::text)',[property,actor,noteId,expected,mutation,document===null?null:JSON.stringify(document),source,legacyVersion])).rows[0]}
test('shared SQL writes enforce roles, creator sharing/deletion, optimistic revisions and idempotent retries',async()=>{const db=await fixture();try{await db.exec('set role service_role');const first=await save(db,owner,null,change(10));assert.equal(first.revision,1);const update=await save(db,tech,1,change(11),{...doc,title:'By tech'});assert.equal(update.revision,2);assert.equal((await save(db,tech,1,change(11),{...doc,title:'By tech'})).revision,2);await assert.rejects(save(db,owner,1,change(12)),/changed elsewhere/);await assert.rejects(save(db,tech,2,change(13),null),/creator/);await assert.rejects(save(db,tech,2,change(14),{...doc,audience:{all:true,roles:[],people:[]}}),/creator/);await assert.rejects(save(db,manager,2,change(15)),/unavailable/);const deleted=await save(db,owner,2,change(16),null);assert.ok(deleted.deleted_at);assert.equal((await save(db,owner,2,change(16),null)).revision,3);await assert.rejects(save(db,owner,null,change(17)),/unavailable|changed elsewhere/)}finally{await db.close()}});
test('private/all/individual audiences and active property membership are authoritative; Data API is closed',async()=>{const db=await fixture();try{await db.exec('set role service_role');const personal={...doc,audience:{all:false,roles:[],people:[]}};await save(db,owner,null,change(20),personal);await assert.rejects(save(db,tech,1,change(21),personal),/unavailable/);const all={...doc,audience:{all:true,roles:[],people:[]}};await save(db,owner,1,change(22),all);await save(db,manager,2,change(23),{...all,title:'Shared'});await assert.rejects(save(db,tech,null,change(24),all,null,change(99),other),/Inactive/);await db.exec(`reset role;update hotel_members set active=false where user_id='${tech}';set role service_role`);await assert.rejects(save(db,tech,3,change(25),all),/Inactive/);await db.exec('set role authenticated');await assert.rejects(db.exec('select * from cmpri_notepad_notes'),/permission denied/);await assert.rejects(save(db,owner,3,change(26),all),/permission denied/)}finally{await db.close()}});
test('first legacy edit preserves owner/time and original data; another account cannot import a private ID or resurrect tombstones',async()=>{const db=await fixture();try{const personal={...doc,audience:{all:false,roles:[],people:[]}};await db.exec(`insert into cmpri_general_notes values('${hotel}','${owner}','${id}','{"text":"original"}','2026-01-01',null,1);set role service_role`);await assert.rejects(save(db,tech,0,change(30),personal,'general'),/unavailable/);await assert.rejects(save(db,tech,null,change(31),personal),/identity already exists/);const first=await save(db,owner,0,change(32),personal,'general');assert.equal(first.author_user_id,owner);assert.equal(new Date(first.created_at).toISOString(),'2026-01-01T00:00:00.000Z');assert.equal((await db.query('select document from cmpri_general_notes')).rows[0].document.text,'original');await db.exec(`reset role;insert into cmpri_general_notes values('${hotel}','${owner}','${change(98)}',null,'2026-01-01','2026-01-02',1);set role service_role`);await assert.rejects(save(db,owner,null,change(33),personal,null,change(98)),/identity already exists/);await db.exec(`reset role;insert into cmpri_staff_notes(hotel_id,id,author_user_id,author_name,created_at,parent_id) values('${hotel}','${change(97)}','${owner}','Entered name','2026-01-01',null);set role service_role`);const staff=await save(db,tech,0,change(34),{...doc,audience:{all:true,roles:[],people:[]}},'staff',change(97));assert.equal(staff.author_user_id,owner);assert.equal(staff.author_name,'Entered name');}finally{await db.close()}});

test('legacy writes and first imports conflict in either serialization order, including replies and metadata',async()=>{
 const db=await fixture();try{
  await db.exec(`insert into cmpri_general_notes values('${hotel}','${owner}','${id}','{"text":"original"}','2026-01-01',null,1);update cmpri_general_notes set document='{"text":"newer legacy edit"}',revision=2 where id='${id}';set role service_role`);
  await assert.rejects(save(db,owner,0,change(40),doc,'general',id,hotel,'general:1'),/changed elsewhere/);
  const imported=await save(db,owner,0,change(41),doc,'general',id,hotel,'general:2');assert.equal(imported.revision,1);
  await db.exec('reset role');await assert.rejects(db.exec(`update cmpri_general_notes set document='{"text":"hidden edit"}',revision=3 where id='${id}'`),error=>error.code==='40001');await assert.rejects(db.exec(`delete from cmpri_general_notes where id='${id}'`),error=>error.code==='40001');
  const root=change(80),reply=change(81),later=change(82);
  await db.exec(`insert into cmpri_staff_notes(hotel_id,id,author_user_id,author_name,created_at,parent_id,body) values('${hotel}','${root}','${owner}','Original author','2026-01-01',null,'Root');`);
  const oldToken=(await db.query('select cmpri_private.notepad_staff_version($1,$2) as token',[hotel,root])).rows[0].token;
  await db.exec(`insert into cmpri_staff_notes(hotel_id,id,author_user_id,author_name,created_at,parent_id,body) values('${hotel}','${reply}','${tech}','Reply author','2026-01-02','${root}','Reply');update cmpri_staff_notes set author_name='Corrected author' where id='${root}';`);
  const records=(await db.query('select *,created_at::text as created_at from cmpri_staff_notes')).rows;
  const projected=legacyStaffNotes(records).notes[0],freshToken=(await db.query('select cmpri_private.notepad_staff_version($1,$2) as token',[hotel,root])).rows[0].token;
  assert.equal(projected.legacyVersion,freshToken);assert.notEqual(freshToken,oldToken);assert.equal(records.find(r=>r.id===root).notepad_revision,1);
  await db.exec('set role service_role');await assert.rejects(save(db,owner,0,change(42),{...doc,audience:{all:true,roles:[],people:[]}},'staff',root,hotel,oldToken),/changed elsewhere/);
  await save(db,owner,0,change(43),{...doc,audience:{all:true,roles:[],people:[]}},'staff',root,hotel,freshToken);await db.exec('reset role');
  for(const sql of [`update cmpri_staff_notes set author_name='Hidden author' where id='${reply}'`,`insert into cmpri_staff_notes(hotel_id,id,author_user_id,author_name,created_at,parent_id,body) values('${hotel}','${later}','${tech}','Reply author','2026-01-03','${reply}','Hidden nested reply')`,`delete from cmpri_staff_notes where id='${reply}'`])await assert.rejects(db.exec(sql),error=>error.code==='40001');
  await db.exec('set role service_role');await save(db,owner,1,change(44),null,null,root);await db.exec('reset role');await assert.rejects(db.exec(`update cmpri_staff_notes set body='Hidden edit after deletion' where id='${root}'`),error=>error.code==='40001');
 }finally{await db.close()}
});

test('real resource signals permit Notepad writes, preserve existing topics and invalidate permitted legacy changes without content',async()=>{
 const db=await fixture();try{
  await db.exec('set role service_role');await save(db,owner,null,change(60),{...doc,audience:{all:false,roles:[],people:[]}});
  let rows=(await db.query("select * from cmpri_resource_signals where topic='notepad' order by recipient_user_id")).rows;assert.equal(rows.length,3);assert.ok(rows.every(r=>r.revision===1));assert.deepEqual(Object.keys(rows[0]).sort(),['hotel_id','recipient_user_id','revision','topic']);
  for(const topic of ['orders','inbox','pool','rooms','feedback','session','reference'])await db.query('insert into cmpri_resource_signals(hotel_id,recipient_user_id,topic) values($1,$2,$3)',[hotel,owner,topic]);
  assert.equal((await db.query('select count(*)::int as n from cmpri_resource_signals where recipient_user_id=$1',[owner])).rows[0].n,8);
  await db.exec(`reset role;insert into cmpri_general_notes values('${hotel}','${owner}','${change(61)}','{"text":"legacy"}','2026-01-01',null,1);update cmpri_general_notes set revision=2 where id='${change(61)}';insert into cmpri_staff_notes(hotel_id,id,author_user_id,author_name,created_at,parent_id,body) values('${hotel}','${change(62)}','${owner}','Original author','2026-01-01',null,'Legacy staff note');update cmpri_staff_notes set author_name='Corrected author' where id='${change(62)}';delete from cmpri_general_notes where id='${change(61)}';delete from cmpri_staff_notes where id='${change(62)}';`);
  rows=(await db.query("select * from cmpri_resource_signals where topic='notepad'")).rows;assert.ok(rows.every(r=>r.revision===7));
  await db.exec(`update hotel_members set active=false where user_id='${tech}';set role service_role;`);await save(db,owner,1,change(63),{...doc,title:'Private new title',audience:{all:false,roles:[],people:[]}});
  rows=(await db.query("select * from cmpri_resource_signals where topic='notepad'")).rows;assert.equal(rows.find(r=>r.recipient_user_id===tech).revision,7);assert.equal(rows.find(r=>r.recipient_user_id===owner).revision,8);assert.doesNotMatch(JSON.stringify(rows),/Private new title|content|document|author/);
 }finally{await db.close()}
});

test('Edit History records authoritative actors and changed fields atomically and respects old and current audiences',async()=>{
 const db=await fixture();try{
  const history=(actor,before=null,property=hotel,note=id)=>db.query('select * from cmpri_read_notepad_history($1,$2,$3,$4)',[property,actor,note,before]).then(result=>result.rows);
  const privateNote={...doc,audience:{all:false,roles:[],people:[]},content:'<p>Private content</p>'};
  const shared={...doc,content:'<p>Shared version</p>'};
  await db.exec('set role service_role');
  await save(db,owner,null,change(101),privateNote);
  await save(db,owner,1,change(102),shared);
  const collaboration={...shared,content:'<p>Collaborator version</p>',itemThreads:{item:[{id:change(130),authorId:tech,at:'2026-11-24T01:00:00Z',text:'Checked this.',replies:[]}]}};
  await save(db,tech,2,change(103),collaboration);
  await save(db,tech,2,change(103),collaboration);
  await save(db,tech,3,change(104),collaboration);
  await assert.rejects(save(db,tech,2,change(105),{...collaboration,title:'Conflict'}),/changed elsewhere/);
  const versions=await history(owner);
  assert.deepEqual(versions.map(v=>v.revision),[3,2,1]);
  assert.deepEqual(versions.map(v=>v.actor_name),['Morgan Ellis','Avery Reed','Avery Reed']);
  assert.equal(versions[0].actor_id,tech);
  assert.ok(versions[0].edited_at);
  assert.equal(versions[0].before_fields.content,shared.content);
  assert.equal(versions[0].after_fields.content,collaboration.content);
  assert.equal(versions[0].after_fields.itemThreads.item[0].text,'Checked this.');
  assert.equal(versions[0].after_fields.title,undefined);
  assert.deepEqual((await history(tech)).map(v=>v.revision),[3]);
  assert.deepEqual((await history(owner,3)).map(v=>v.revision),[2,1]);
  assert.deepEqual(await history(manager),[]);
  assert.deepEqual(await history(owner,null,other),[]);
  await save(db,owner,3,change(106),privateNote);
  assert.deepEqual(await history(tech),[]);
  await save(db,owner,4,change(107),null);
  assert.deepEqual(await history(owner),[]);
  assert.equal((await db.query('select count(*)::int as count from cmpri_notepad_history')).rows[0].count,0);
  await db.exec('set role authenticated');
  await assert.rejects(history(owner),/permission denied/);
  await assert.rejects(db.exec('select * from cmpri_notepad_history'),/permission denied/);
 }finally{await db.close();}
});

test('history can begin after an older note lacking optional snapshot data',async()=>{
 const db=await fixture();try{
  const {attachments,ink,itemThreads,...older}=doc;
  await db.exec('set role service_role');
  await db.query('select cmpri_private.cmpri_save_notepad($1,$2,$3,null,$4,$5)',[hotel,owner,id,change(110),JSON.stringify(older)]);
  await save(db,owner,1,change(111),{...doc,title:'New title'});
  const rows=(await db.query('select * from cmpri_read_notepad_history($1,$2,$3,null)',[hotel,owner,id])).rows;
  assert.equal(rows.length,1);
  assert.equal(rows[0].before_fields.title,doc.title);
  assert.equal(rows[0].after_fields.title,'New title');
  assert.equal(rows[0].before_fields.drawing,undefined);
  assert.equal(rows[0].before_fields.attachments,undefined);
  assert.equal(rows[0].before_fields.itemThreads,undefined);
 }finally{await db.close();}
});
