import test from 'node:test';
import assert from 'node:assert/strict';
import {Blocked,failed,classified,requirePrerequisite} from './outcomes.mjs';
test('missing prerequisites remain blocked and non-passing',()=>{
 assert.throws(()=>requirePrerequisite(false,'No persisted photo'),Blocked);
 const result=failed(new Blocked('No persisted photo'),{role:'fixture'});
 assert.equal(result.status,'BLOCKED');assert.equal(result.passed,false);
 assert.equal(classified([result])[0].status,'BLOCKED');
});
test('failed assertions stay failures; HTTP evidence survives status classification',()=>{
 assert.equal(failed(new Error('Wrong bytes')).status,'FAIL');
 const result=classified([{status:200,passed:true}])[0];
 assert.equal(result.status,'PASS');assert.equal(result.httpStatus,200);
 assert.equal(classified([{passed:false}])[0].status,'FAIL');
});
