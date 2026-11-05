import test from 'node:test';
import assert from 'node:assert/strict';
import { tapTask, taskEditable, taskComplete, taskVisual } from '../src/lib/pm/task-review.ts';
const chief = {id:'chief',name:'Scott',role:'chief'};
const tech = {id:'alex',name:'Alex',role:'technician'};
const other = {id:'sam',name:'Sam',role:'technician'};
const manager = {id:'deon',name:'Deon',role:'manager'};
test('chief direct checks go blank to green and back', () => {
 const checked=tapTask(undefined,chief); assert.equal(checked.status,'approved');
 assert.equal(tapTask(checked,chief).status,'empty');
});
test('review cycles preserve original worker and technician completion', () => {
 let state=tapTask(undefined,tech,{attachedForm:true});
 assert.equal(taskVisual(state,chief),'needs'); assert.equal(taskVisual(state,tech),'approved');
 assert.equal(taskVisual(state,manager),'needs');
 state=tapTask(state,chief,{attachedForm:true}); assert.equal(state.status,'approved'); assert.equal(state.attachedFormStatus,'final');
 state=tapTask(state,chief,{attachedForm:true}); assert.equal(state.status,'empty'); assert.equal(taskComplete(state),true); assert.equal(state.workerName,'Alex');
 state=tapTask(state,chief); assert.equal(state.status,'needs'); assert.equal(state.workerId,'alex');
});
test('technicians may undo their own work, never someone else’s; managers cannot edit', () => {
 const state=tapTask(undefined,tech);
 assert.equal(taskEditable(state,other),false); assert.throws(()=>tapTask(state,other));
 assert.equal(tapTask(state,tech).workerChecked,false);
 assert.throws(()=>tapTask(state,manager));
});
test('pool requires matching log, locks submission, and permits only chief approval', () => {
 assert.throws(()=>tapTask(undefined,tech,{pool:true}),/Pool Log/);
 const state=tapTask(undefined,tech,{pool:true,poolLogFilled:true});
 assert.equal(state.poolSubmitted,true); assert.throws(()=>tapTask(state,tech));
 const approved=tapTask(state,chief,{pool:true});
 assert.equal(approved.status,'approved'); assert.equal(approved.workerId,'alex');
 assert.throws(()=>tapTask(approved,chief,{pool:true}));
});

test('weekly finalization preserves linked draft fields and worker identity', async () => {
 const { projectLinkedFormReviews } = await import('../src/lib/pm/linked-form-review.ts');
 const templates=[{id:'weekly',kind:'routine',cadence:'weekly',sourceFile:'sheet',checklist:[{id:'walk',source:'Walk.pdf'}]},{id:'walk-form',kind:'form',cadence:'weekly',sourceFile:'Walk.pdf',checklist:[]}];
 const form={template_id:'walk-form',period_start:'2026-11-02',scope_key:'property',is_complete:false,form_data:{unfinished:'draft'},notes:'keep'};
 const ledger={template_id:'weekly',period_start:'2026-11-02',task_states:{walk:{status:'approved',attachedFormStatus:'final',workerName:'Alex'}}};
 const result=projectLinkedFormReviews([form,ledger],templates)[0];
 assert.equal(result.is_complete,true);assert.equal(result.completed_by_name,'Alex');assert.deepEqual(result.form_data,{unfinished:'draft'});assert.equal(form.is_complete,false);
 assert.equal(projectLinkedFormReviews([{...form,period_start:'2026-10-26'},ledger],templates)[0].is_complete,false);
});
