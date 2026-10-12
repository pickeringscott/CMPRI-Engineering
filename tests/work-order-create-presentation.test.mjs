import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './helpers/load-ts.mjs';
const {keepCreateFormOpen}=loadTs('src/lib/work-order-create-presentation.ts');
test('only existing nontechnical submitters keep the successful form open',()=>{
 for(const role of ['front_desk','housekeeping','front_desk_manager','assistant_manager','manager']) {
  assert.equal(keepCreateFormOpen({role},true),true,role);
  assert.equal(keepCreateFormOpen({role},false),false,role);
 }
 for(const role of ['engineer','chief_engineer','technician','system_admin','senior_management','unknown']) assert.equal(keepCreateFormOpen({role},true),false,role);
 assert.equal(keepCreateFormOpen({role:'front_desk',secondary_roles:['engineer']},true),false);
});
