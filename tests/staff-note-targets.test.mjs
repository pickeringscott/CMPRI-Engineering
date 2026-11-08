import test from 'node:test';
import assert from 'node:assert/strict';
import {staffMentionDirectory,staffMentionMatches,staffMentionCompletion,resolveStaffMentions,staffRecipients,STAFF_ROLE_MENTIONS,staffTicketReferences,staffAuthorMention} from '../src/lib/staff-notes.ts';
import {staffMentionSuggestions,staffMentionQuery,staffReferenceQuery,insertStaffMention,rebaseStaffMentions,selectedStaffMentions} from '../src/lib/staff-note-targets.ts';
import {staffNoteFlagExpiry,staffNoteFlagCutoff,staffNoteFlagWindows} from '../src/lib/staff-note-flags.ts';
import {staffNotesDatabase,staffId as id,staffHotel as hotel,foreignHotel,staffProfiles} from './helpers/staff-notes-db.mjs';
const profiles=staffProfiles.filter(p=>p.active&&!p.hotel_id);
test('first and last aliases bind people and registered names without guessing duplicate first names',()=>{
 const people=[{id:'alex-one',role:'technician',full_name:'Alex Chen'},{id:'alex-two',role:'technician',full_name:'Alex Rivera'}];
 const directory=staffMentionDirectory(people,[{id:'desk-taylor',name:'Taylor Reed'}]);
 const choices=staffMentionSuggestions('Alex',directory);
 assert.deepEqual(choices.map(m=>[m.id,m.label,m.description]),[['alex-one','Alex','Alex Chen'],['alex-two','Alex','Alex Rivera']]);
 assert.equal(staffMentionMatches('@Alex',directory).length,0);
 const chosen=insertStaffMention('@Alex',{start:0,end:5},choices[1],[]);
 assert.equal(chosen.value,'@Alex ');assert.equal(resolveStaffMentions(chosen.value,chosen.mentions,directory)[0].id,'alex-two');
 assert.equal(staffMentionSuggestions('Tay',directory)[0].label,'Taylor');
 assert.equal(resolveStaffMentions('@Taylor thanks',[],directory)[0].id,'desk-taylor');
 assert.equal(resolveStaffMentions('@Reed thanks',[],directory)[0].id,'desk-taylor');
 assert.equal(staffAuthorMention({author_name:'Alex Rivera',author_user_id:'alex-two'},directory).label,'Alex');
});
test('Scott Pickering and all his aliases are unavailable, without excluding another Scott',()=>{
 const directory=staffMentionDirectory([{id:'admin',role:'system_admin',full_name:' Scott  Pickering '},{id:'other-scott',role:'technician',full_name:'Scott Reed'}]);
 assert.equal(directory.some(m=>m.kind==='person'&&m.id==='admin'),false);
 assert.equal(staffMentionSuggestions('Pickering',directory).length,0);
 assert.deepEqual(staffMentionSuggestions('Scott',directory).map(m=>m.id),['other-scott']);
 assert.equal(staffAuthorMention({author_name:'Scott',author_user_id:'admin'},directory),null);
 assert.equal(resolveStaffMentions('@Scott Pickering',[],directory).some(m=>m.id==='admin'),false);
 assert.throws(()=>resolveStaffMentions('@Scott',[{id:'admin',kind:'person',label:'Scott',start:0,end:6}],directory),/no longer available/);
});
test('first names precede surname matches while surnames keep full target identity',()=>{
 const directory=staffMentionDirectory([
  {id:'first',role:'technician',full_name:'Morgan Lane'},
  {id:'last',role:'technician',full_name:'Alex Morgan'},
 ],[{id:'desk',name:'Taylor Morgan'}],[{id:'room',name:'Lobby Morgan'}]);
 const matches=staffMentionSuggestions('morg',directory);
 assert.deepEqual(matches.map(m=>[m.id,m.label]),[['first','Morgan'],['last','Morgan'],['desk','Morgan']]);
 const surname=staffMentionSuggestions('lane',directory);
 assert.equal(surname[0].id,'first');assert.equal(surname[0].label,'Lane');
 assert.equal(staffMentionCompletion('@lane',5,directory),null);
 const inserted=insertStaffMention('@lane',{start:0,end:5},surname[0],[]);
 assert.equal(inserted.value,'@Lane ');
 assert.equal(resolveStaffMentions(inserted.value,inserted.mentions,directory)[0].id,'first');
});
test('the real public directory keeps alias identity without exposing private recipient arrays',()=>{
 const publicDirectory=staffMentionDirectory(profiles).map(m=>({...m,userIds:[]}));
 const completion=staffMentionCompletion('@Sc',3,publicDirectory);
 assert.equal(completion.mention.id,id(2));assert.equal(completion.mention.kind,'person');assert.equal(completion.mention.label,'Scott');
 assert.equal(staffMentionSuggestions('Alex',publicDirectory).length,2);
 assert.equal(staffMentionCompletion('@Alex',5,publicDirectory),null);
 assert.ok(staffMentionSuggestions('',publicDirectory).some(m=>m.kind==='role'));
});
test('selected people, roles, display names and numeric rooms never exchange target identity',()=>{
 const directory=staffMentionDirectory(profiles,[{id:id(41),name:'Alex Rivera'}],[{id:id(21),room_number:'204'}]);
 for(const [kind,target] of [['person',id(4)],['front_desk_name',id(41)],['location',id(21)],['role','housekeeping']]){
  const choice=directory.find(m=>m.kind===kind&&m.id===target),draft=insertStaffMention('',{start:0,end:0},choice,[]);
  const spans=resolveStaffMentions(draft.value,draft.mentions,directory);assert.equal(spans[0].kind,kind);assert.equal(spans[0].id,target);
  const recipients=staffRecipients(draft.value,profiles,spans).map(r=>r.user_id);
  assert.equal(recipients.includes(id(4)),kind==='person'||kind==='role');
  assert.equal(recipients.includes(id(6)),false,'A display name is never a shared-account notification');
 }
 assert.throws(()=>resolveStaffMentions('@Alex Rivera',[{id:id(98),kind:'person',label:'Alex Rivera',start:0,end:12}],directory),/no longer available/);
});
test('edits move stable spans around native emoji, invalidate edited names, and retain supported ticket forms',()=>{
 const target=staffMentionDirectory(profiles).find(m=>m.kind==='person'&&m.id===id(4));
 const draft=insertStaffMention('😀 ',{start:3,end:3},target,[]),prefixed='👩🏽‍🔧 '+draft.value;
 const moved=rebaseStaffMentions(draft.value,prefixed,draft.mentions);assert.equal(prefixed.slice(moved[0].start,moved[0].end),'@Alex Rivera');
 assert.equal(rebaseStaffMentions(draft.value,draft.value.replace('Rivera','Chen'),draft.mentions).length,0);
 const body='#4218';assert.ok(selectedStaffMentions(body,[{id:id(31),kind:'work_order',label:'WO#4218',start:0,end:body.length}]));
 assert.equal(selectedStaffMentions(body,[{id:id(31),kind:'work_order',label:'WO#9911',start:0,end:body.length}]),null);
});
test('Front Desk flag expires at six AM on day three, including both Chicago DST changes',()=>{
 assert.equal(staffNoteFlagExpiry('2026-11-03T20:00:00Z'),'2026-11-06T12:00:00.000Z');
 assert.equal(staffNoteFlagExpiry('2026-03-06T20:00:00Z'),'2026-03-09T11:00:00.000Z');
 assert.equal(staffNoteFlagExpiry('2026-10-30T19:00:00Z'),'2026-11-02T12:00:00.000Z');
 assert.equal(staffNoteFlagCutoff(new Date('2026-11-06T11:59:59Z')),'2026-11-03T06:00:00.000Z');
 assert.equal(staffNoteFlagCutoff(new Date('2026-11-06T12:00:00Z')),'2026-11-04T06:00:00.000Z');
});
test('every supported role label retains its role identity and matching authorized recipients',()=>{
 const directory=staffMentionDirectory(profiles);
 for(const [label,role] of STAFF_ROLE_MENTIONS){
  const target=staffMentionSuggestions(label,directory).find(m=>m.kind==='role'&&m.label===label);
  assert.equal(target.id,role);const draft=insertStaffMention('',{start:0,end:0},target,[]);
  const resolved=resolveStaffMentions(draft.value,draft.mentions,directory);
  assert.equal(resolved[0].kind,'role');assert.equal(resolved[0].id,role);
  const recipients=staffRecipients(draft.value,profiles,resolved);
  for(const id of target.userIds)assert.ok(recipients.some(r=>r.user_id===id),label);
 }
});
test('author-click shortcuts retain saved account/display identity and never guess an ambiguous historical label',()=>{
 const directory=staffMentionDirectory(profiles,[{id:id(41),name:'Alex Rivera'}]);
 assert.equal(staffAuthorMention({author_name:'Alex Rivera',author_user_id:id(6),author_name_id:id(41)},directory).kind,'front_desk_name');
 assert.equal(staffAuthorMention({author_name:'Alex Rivera',author_user_id:id(4)},directory).id,id(4));
 assert.equal(staffAuthorMention({author_name:'Alex Rivera'},directory),null);
});
test('email addresses and pasted URL paths do not become name mentions or ticket references',()=>{
 const directory=staffMentionDirectory(profiles);
 for(const body of ['someone@Scott.example','https://example.invalid/@Scott','https://example.invalid/#4218']){
  assert.equal(staffMentionQuery(body,body.length),null);
  assert.equal(staffReferenceQuery(body,body.length),null);
  assert.deepEqual(resolveStaffMentions(body,[],directory),[]);
  assert.deepEqual(staffTicketReferences(body),[]);
 }
 const body='https://example.invalid/@Scott';assert.equal(selectedStaffMentions(body,[{id:id(2),kind:'person',label:'Scott',start:body.indexOf('@'),end:body.length}]),null);
});
test('Front Desk expiry removes only elapsed calendar windows while keeping newer notes flagged',()=>{
 const notes=[{created_at:'2026-11-03T20:00:00Z'},{created_at:'2026-11-04T20:00:00Z'},{created_at:'2026-11-04T21:00:00Z'}];
 assert.deepEqual(staffNoteFlagWindows(notes,new Date('2026-11-06T12:00:00Z')),[{expiresAt:'2026-11-07T12:00:00.000Z',count:2}]);
});
test('migration makes historical shared-account author names mentionable without rewriting their notes',async()=>{
 const legacy=id(81),db=await staffNotesDatabase(async db=>{
  await db.query('insert into cmpri_staff_notes(id,hotel_id,author_user_id,author_name,body,created_at,request_id) values($1,$2,$3,$4,$5,$6,gen_random_uuid()),($7,$2,$3,$8,$5,$6,gen_random_uuid()),($9,$2,$10,$11,$5,$6,gen_random_uuid())',[legacy,hotel,id(6),'Jamie Agent','Historical 😀 note','2026-11-01T20:00:00Z',id(82),'Front Desk',id(83),id(2),'Scott']);
 });try{
  assert.deepEqual((await db.query('select name from cmpri_staff_note_names')).rows,[{name:'Jamie Agent'}]);
  const note=(await db.query('select author_name,body,mentions,author_name_id from cmpri_staff_notes where id=$1',[legacy])).rows[0];
  assert.deepEqual(note,{author_name:'Jamie Agent',body:'Historical 😀 note',mentions:[],author_name_id:null});
 }finally{await db.close()}
});
test('real SQL atomically stores target identities and replies, rejects changed retries and foreign names, and preserves unrelated records',async()=>{
 const db=await staffNotesDatabase();try{
  const named=(await db.query('select * from cmpri_capture_staff_note_name($1,$2,$3)',[hotel,id(6),'Jamie Front Desk'])).rows[0];
  assert.equal((await db.query('select * from cmpri_capture_staff_note_name($1,$2,$3)',[hotel,id(6),'jamie  front desk'])).rows[0].id,named.id);
  const mentions=[{id:id(4),kind:'person',label:'Alex Rivera',start:0,end:12}],body='@Alex Rivera 😀 #handoff';
  const post=async(request=id(51),parent=null,refs=mentions,nameId=null)=>(await db.query('select cmpri_post_staff_note_with_mentions($1,$2,$3,$4,$5,$6,$7::jsonb,$8::uuid[],$9::text[],$10::jsonb,$11::jsonb,$12) id',[hotel,id(2),'Scott',body,parent,request,JSON.stringify([{user_id:id(4),push:true}]),[],['#handoff'],'[]',JSON.stringify(refs),nameId])).rows[0].id;
  const note=await post();assert.equal(await post(),note);
  const saved=(await db.query('select body,mentions from cmpri_staff_notes where id=$1',[note])).rows[0];assert.equal(saved.body,body);assert.deepEqual(saved.mentions,mentions);
  assert.equal((await db.query('select count(*)::int n from cmpri_web_push_deliveries where recipient_user_id=$1',[id(4)])).rows[0].n,1);
  await assert.rejects(post(id(51),null,[{...mentions[0],id:id(5)}]),/Request already used/);
  const reply=await post(id(52),note);assert.equal((await db.query('select parent_id from cmpri_staff_notes where id=$1',[reply])).rows[0].parent_id,note);
  const foreign=(await db.query('select * from cmpri_capture_staff_note_name($1,$2,$3)',[foreignHotel,id(98),'Foreign Name'])).rows[0];
  await assert.rejects(post(id(53),null,mentions,foreign.id),/Invalid Front Desk name/);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(98)]);await db.exec('set role authenticated');
  assert.equal((await db.query('select * from cmpri_staff_notes')).rows.length,0);assert.equal((await db.query('select * from cmpri_staff_note_names')).rows.length,1);
  await assert.rejects(post(id(54)),/permission denied/);await assert.rejects(db.query('select * from cmpri_capture_staff_note_name($1,$2,$3)',[hotel,id(6),'Forged']),/permission denied/);
  await db.exec('reset role');assert.deepEqual((await db.query('select value from untouched')).rows[0].value,{hours:19,profile:'unchanged',feedback:'private'});
 }finally{await db.close()}
});
