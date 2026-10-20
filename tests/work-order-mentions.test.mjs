import {plainTextParts} from '../src/lib/plain-text-links.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers/load-ts.mjs';
import * as references from '../src/lib/work-order-reference.js';
const policy = loadTs('src/lib/work-order-mentions.ts',{'./plain-text-links':{plainTextParts}});
const profiles = [
  {id:'chief',full_name:'Scott Pickering',role:'system_admin',secondary_roles:['Chief Engineer']},
  {id:'tech',full_name:'Pat Technician',role:'Maintenance Technician'},
  {id:'fdm',full_name:'Dana Manager',role:'Front Desk Manager'},
  {id:'fd',full_name:'Front Desk',role:'Front Desk'},
  {id:'house',full_name:'Deon Housekeeper',role:'Lead Housekeeper'},
  {id:'gm',full_name:'Jules Manager',role:'General Manager'},
  {id:'agm',full_name:'Alex Manager',role:'Assistant General Manager'},
  {id:'senior',full_name:'Robin Director',role:'Senior Management'},
];
test('ticket directory contains staff first names and entire position titles for every role',()=>{
  const directory=policy.workOrderMentionDirectory(profiles);
  for(const label of ['Scott','Pat','Dana','Deon','Jules','Alex','Robin','Chief Engineer','Maintenance Technician','Front Desk Manager','Front Desk','Lead Housekeeper','General Manager','Assistant General Manager','Senior Management','System Administrator']) assert.ok(directory.some(item=>item.label===label),label);
  assert.ok(!directory.some(item=>/Pickering|Technician$/.test(item.label)&&item.kind==='staff'));
  assert.deepEqual(Array.from(policy.workOrderMentionRecipients('@Chief Engineer @Scott @Front Desk Manager',profiles,'tech')),['chief','fdm']);
  assert.deepEqual(Array.from(policy.workOrderMentionRecipients('@Front Desk Manager',profiles,'chief')),['fdm']);
});
test('typed/pasted, unicode, multiline and punctuated mentions use exact longest labels; URLs/emails do not notify',()=>{
  const directory=policy.workOrderMentionDirectory(profiles);
  for(const text of ['@Scott','😀 @SCOTT,\n@Lead Housekeeper','Please ask (@Scott).']) assert.ok(policy.workOrderStaffMentions(text,directory).length>0,text);
  for(const text of ['person@Scott.com','@Scottish','https://example.test/@Scott','https://example.test/@Front%20Desk']) assert.equal(policy.workOrderStaffMentions(text,directory).length,0,text);
  assert.deepEqual(Array.from(policy.workOrderMentionRecipients('@Front Desk Manager',profiles,'chief')),['fdm']);
  assert.equal(policy.workOrderStaffMentions('@Front Desk Manager',directory)[0].mention.label,'Front Desk Manager');
});
test('recipient IDs are deduplicated, opt-outs respected and the author is excluded',()=>{
  const duplicate=[...profiles,{id:'other-scott',full_name:'Scott Other',role:'technician'},{id:'optout',full_name:'Sam Optout',role:'technician',preferences:{notifications:{mentions:false}}}];
  assert.deepEqual(Array.from(policy.workOrderMentionRecipients('@Scott @Maintenance Technician @Sam',duplicate,'tech')),['chief','other-scott']);
  assert.deepEqual(Array.from(policy.workOrderMentionRecipients('@Scott',profiles,'chief')),[]);
});
test('only newly added note bodies notify; unchanged history, change entries and author labels do not',()=>{
  const before='CMPRI2|2026-10-01T10:00:00Z|@Scott|Chief Engineer|note|Old @Pat';
  const note='CMPRI2|2026-10-20T10:00:00Z|Author|Front Desk|note|New @Scott';
  const change='CMPRI2|2026-10-20T11:00:00Z|Author|Front Desk|change|Assigned @Pat';
  assert.equal(policy.addedWorkOrderNoteText(before,before+'\n'+note+'\n'+change),'New @Scott');
  assert.equal(policy.addedWorkOrderNoteText(before,before),'');
  assert.equal(policy.addedWorkOrderNoteText(before+'\n'+note,note+'\n'+before),'');
  assert.equal(policy.addedWorkOrderNoteText('', 'CMPRI|date|Author|note|@Scott'),'@Scott');
});
test('completion keeps the entire role and preserves newline, punctuation, emoji and trailing text at the caret',()=>{
  const text='😀 before\n@Front Desk M after';const caret=text.indexOf(' after');
  const query=policy.workOrderMentionQuery(text,caret);
  assert.equal(query.query,'front desk m');
  const inserted=policy.insertWorkOrderMention(text,query,'Front Desk Manager');
  assert.equal(inserted.value,'😀 before\n@Front Desk Manager  after');
  assert.equal(inserted.caret,inserted.value.indexOf('  after')+1);
  assert.equal(policy.workOrderMentionQuery('email@Scott',11),null);
  assert.equal(policy.workOrderMentionQuery('https://example.test/@Scott',26),null);
  assert.ok(references.workOrderReferences('See @WO#123 and @WO-456').length===2);
});

test('saving resolves only active hotel profiles and uses atomic persistence for mentioned notes',async()=>{
  const calls=[];const filters=[];
  const admin={from(table){const q={select(){return q},eq(k,v){filters.push([table,k,v]);return q},in(k,v){filters.push([table,k,Array.from(v)]);return q},then(resolve,reject){return Promise.resolve({data:table==='hotel_members'?profiles.map(p=>({user_id:p.id})):profiles,error:null}).then(resolve,reject)}};return q},async rpc(name,input){calls.push({name,input});return {data:{revision:8},error:null}}};
  const server=loadTs('src/lib/server/work-order-mentions.ts',{'@/lib/work-order-mentions':policy});
  const update={notes:'CMPRI2|date|Author|Front Desk|note|@Scott @Chief Engineer @Front Desk Manager',history_actor_user_id:'fd'};
  const result=await server.persistMentionedWorkOrder(admin,{hotelId:'hotel',id:'ticket',actorId:'fd',revision:7,beforeNotes:'',update,openOnly:true});
  assert.equal(result.data.revision,8);assert.equal(calls[0].name,'cmpri_save_mentioned_work_order');
  assert.deepEqual(Array.from(calls[0].input.p_recipients),['chief','fdm']);assert.equal(calls[0].input.p_open_only,true);
  assert.ok(filters.some(f=>f[0]==='hotel_members'&&f[1]==='hotel_id'&&f[2]==='hotel'));
  assert.ok(filters.some(f=>f[0]==='profiles'&&f[1]==='active'&&f[2]===true));
  assert.equal(await server.persistMentionedWorkOrder(admin,{hotelId:'hotel',id:'ticket',actorId:'fd',revision:8,beforeNotes:update.notes,update}),null);
  const publicDirectory=await server.loadPublicWorkOrderMentions(admin,'hotel');assert.ok(publicDirectory.every(m=>Object.keys(m).sort().join(',')==='kind,label'));
  const failing={from(){return {select(){return this},eq(){return this},then(resolve){resolve({error:{message:'offline'}})}}}};
  await assert.rejects(server.persistMentionedWorkOrder(failing,{hotelId:'hotel',id:'ticket',actorId:'fd',revision:7,beforeNotes:'',update}),/could not be loaded/);
});


test('explicit mention push reaches eligible named/role recipients without broadening ordinary work-order alerts',()=>{
 const event=loadTs('src/lib/notifications/event-eligibility.ts',{'@/lib/server/roles':loadTs('src/lib/server/roles.ts')});
 for(const role of ['Chief Engineer','Maintenance Technician','General Manager','Assistant General Manager','Front Desk Manager','Lead Housekeeper','Senior Management','System Administrator'])assert.equal(event.receivesEventPush({role},{id:'work-order-mention:ticket:2',work_order_id:'ticket'}),true,role);
 for(const role of ['Front Desk','unknown'])assert.equal(event.receivesEventPush({role},{id:'work-order-mention:ticket:2',work_order_id:'ticket'}),false,role);
 assert.equal(event.receivesEventPush({role:'General Manager'},{id:'new-order:ticket',work_order_id:'ticket'}),false);
 assert.equal(event.receivesEventPush({role:'Front Desk',secondary_roles:['Chief Engineer']},{id:'work-order-mention:ticket:2'}),false);
});
