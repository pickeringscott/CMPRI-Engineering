import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers/load-ts.mjs';
const {canReadWorkOrder,workOrderReadFilter}=loadTs('src/lib/work-order-read-policy.ts');
const {workOrderReader}=loadTs('src/lib/server/work-order-reader.ts');
const {allows}=loadTs('src/lib/server/access.ts');
const {roleKey}=loadTs('src/lib/server/roles.ts');
const user='00000000-0000-4000-8000-000000000001';
const hotel='00000000-0000-4000-8000-000000000002';
const roles=['engineer','chief_engineer','system_admin','technician','manager','senior_management','front_desk_manager','assistant_manager','front_desk','housekeeping'];
function principal(role) {return {identity:{id:user},hotelId:hotel,profile:{id:user,role,active:true,full_name:'Same Display Name'},membership:{hotel_id:hotel,user_id:user,active:true,role:'admin'},permissions:[{role,permission:'manage_work_orders',allowed:true}]};}
for(const role of roles) test(`${role}: all ticket states and creators preserve hotel and activation boundaries`,()=>{
 const reader=workOrderReader(principal(role));
 for(const status of ['Open','In Progress']) for(const created_by of [user,'other',null]) {
  assert.equal(canReadWorkOrder(reader,{hotel_id:hotel,status,created_by,technician_name:'Another Technician'}),true);
  assert.equal(canReadWorkOrder(reader,{hotel_id:'other-hotel',status,created_by,technician_name:'Same Display Name'}),false);
 }
 assert.equal(canReadWorkOrder(reader,{hotel_id:hotel,status:'Closed',created_by:user,technician_name:'Another Technician'}),true);
 const broad=true;
 assert.equal(canReadWorkOrder(reader,{hotel_id:hotel,status:'Closed',created_by:'other',creator_name:'Same Display Name',technician_name:'Another Technician'}),broad);
 for(const status of ['Pending Verification','Completed','Will Not Do','Draft','Unknown','']) assert.equal(canReadWorkOrder(reader,{hotel_id:hotel,status,created_by:user,technician_name:'Another Technician'}),broad,`${role}/${status}`);
 const p=principal(role);p.membership.active=false;
 assert.equal(canReadWorkOrder(workOrderReader(p),{hotel_id:hotel,status:'Open'}),false);
 p.membership.active=true;p.profile.active=false;
 assert.equal(canReadWorkOrder(workOrderReader(p),{hotel_id:hotel,status:'Closed',created_by:user}),false);
});
test('technician existing assigned technical detail reads remain broader without changing assignment mutation policy',()=>{
 const p=principal('technician'),reader=workOrderReader(p);
 for(const status of ['Closed','Completed','Pending Verification','Will Not Do']) assert.equal(canReadWorkOrder(reader,{hotel_id:hotel,status,technician_name:'Same Display Name'}),true);
 const {canAccessWorkOrderByAssignment}=loadTs('src/lib/server/work-order-assignment.ts');
 assert.equal(canAccessWorkOrderByAssignment(p.profile.role,p.profile.full_name,{technician_name:'Another Technician'}),false);
 assert.equal(allows(p,'review_tickets'),false);
 assert.equal(roleKey(p.profile.role),'technician');
});
test('active members list all states; denied readers still fail closed',()=>{
 const filter=workOrderReadFilter(workOrderReader(principal('front_desk')));
 assert.equal(filter,null);
 assert.equal(workOrderReadFilter({...workOrderReader(principal('front_desk')),canRead:false}),'id.is.null');
});
