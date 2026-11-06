import test from 'node:test';
import assert from 'node:assert/strict';
import {profileCanReopenPool,roleCanEditSavedPoolLog,roleAllows} from '../src/lib/server/roles.ts';

test('pool overrides are restricted to Engineering, GM and AGM including assigned secondary roles',()=>{
 for(const role of ['chief_engineer','engineer','General Manager','manager','gm','assistant_manager','Assistant General Manager']) assert.equal(profileCanReopenPool({role}),true,role);
 for(const role of ['front_desk_manager','front_desk','technician','housekeeping','senior_management','system_admin','unknown']) assert.equal(profileCanReopenPool({role}),false,role);
 assert.equal(profileCanReopenPool({role:'front_desk',secondary_roles:['assistant_manager']}),true);
 assert.equal(profileCanReopenPool({role:'front_desk',secondary_roles:['front_desk_manager']}),false);
});
test('GM/AGM may operate and correct pool logs without acquiring unrelated technical privileges',()=>{
 for(const role of ['manager','General Manager','assistant_manager','Assistant General Manager']){
  assert.equal(roleAllows(role,'view_pool_log'),true);
  assert.equal(roleAllows(role,'operate_pool_log'),true);
  assert.equal(roleCanEditSavedPoolLog(role),true);
  assert.equal(roleAllows(role,'edit_tickets'),false);
 }
 for(const role of ['front_desk_manager','front_desk','technician','housekeeping','senior_management','engineer'])assert.equal(roleCanEditSavedPoolLog(role),false,role);
 assert.equal(roleCanEditSavedPoolLog('system_admin'),true);
});
