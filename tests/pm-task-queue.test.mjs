import test from 'node:test';
import assert from 'node:assert/strict';
import { queuePmTask, pmTaskStatesEqual, pmQueueStorageKey, readPmTaskQueue } from '../src/lib/pm/task-queue.ts';
const tech={id:'alex',name:'Alex',role:'technician'},chief={id:'chief',name:'Chief',role:'chief'};
const period={templateId:'workbook:daily',periodStart:'2026-11-16',expectedRevision:7};
const context={weekStart:'2026-11-16',frequency:'daily',tab:'week',phoneDay:3};
test('repeated technician changes reduce to a net intent and cancel when unchecked again',()=>{
 let pending=queuePmTask([],period,'fire',undefined,tech,{});
 assert.equal(pending.length,1);assert.equal(pending[0].changes[0].tapCount,1);
 pending=queuePmTask(pending,period,'fire',undefined,tech,{});assert.deepEqual(pending,[]);
});
test('chief three-step review cycle is represented minimally without erasing completion ownership',()=>{
 const base={status:'needs',workerChecked:true,workerId:'sam',workerName:'Sam'};
 let pending=queuePmTask([],period,'fire',base,chief,{});
 assert.equal(pending[0].changes[0].desiredState.status,'approved');
 pending=queuePmTask(pending,period,'fire',base,chief,{});assert.equal(pending[0].changes[0].tapCount,2);
 assert.equal(pending[0].changes[0].desiredState.workerId,'sam');
 pending=queuePmTask(pending,period,'fire',base,chief,{});assert.deepEqual(pending,[]);
});
test('unrelated tasks share one period but separate weeks keep separate revisions',()=>{
 let pending=queuePmTask([],period,'fire',undefined,tech,{});
 pending=queuePmTask(pending,period,'doors',undefined,tech,{});
 pending=queuePmTask(pending,{...period,periodStart:'2026-11-23',expectedRevision:3},'fire',undefined,tech,{});
 assert.equal(pending.length,2);assert.equal(pending[0].changes.length,2);assert.equal(pending[1].expectedRevision,3);
});
test('a recovered null baseline cannot be silently rebased to new server ownership',()=>{
 let pending=queuePmTask([],period,'fire',undefined,tech,{});
 pending=queuePmTask(pending,period,'fire',{status:'needs',workerId:'other',workerChecked:true},tech,{});
 assert.deepEqual(pending,[]);
});
test('JSON roundtrip preserves pending checks and selected week without credentials',()=>{
 const periods=queuePmTask([],period,'fire',undefined,tech,{}),raw=JSON.stringify({version:1,periods,context});
 assert.deepEqual(readPmTaskQueue(raw),{version:1,periods,context});
 assert.equal(readPmTaskQueue(JSON.stringify({version:1,periods,context:{...context,frequency:'history'}})).periods.length,1);
 assert.notEqual(pmQueueStorageKey('hotel','alex'),pmQueueStorageKey('hotel','sam'));
 assert.notEqual(pmQueueStorageKey('hotel','alex'),pmQueueStorageKey('other','alex'));
});
test('corrupt, duplicate and oversized local queues cannot restore unchecked instructions',()=>{
 assert.equal(readPmTaskQueue('{bad'),null);assert.equal(readPmTaskQueue(JSON.stringify({version:1,periods:[],context:{...context,weekStart:'2026-99-99'}})),null);assert.equal(readPmTaskQueue('x'.repeat(500001)),null);
 const periods=queuePmTask([],period,'fire',undefined,tech,{});
 assert.equal(readPmTaskQueue(JSON.stringify({version:1,periods:[...periods,...periods],context})),null);
 assert.equal(readPmTaskQueue(JSON.stringify({version:1,periods,context:{...context,phoneDay:8}})),null);
});
test('state comparisons normalize absent legacy empty flags but preserve worker ownership',()=>{
 assert.equal(pmTaskStatesEqual(undefined,{status:'empty',workerChecked:false}),true);
 assert.equal(pmTaskStatesEqual({status:'needs',workerChecked:true,workerId:'alex'},{status:'needs',workerChecked:true,workerId:'sam'}),false);
});
