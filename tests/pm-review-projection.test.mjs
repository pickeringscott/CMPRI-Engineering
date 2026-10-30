import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedRoutineUnverifiedItems} from '../src/lib/pm/proposal-projection.ts';
test('unrelated sparse edits retain uncertainty; explicit later answers clear only their own flag',()=>{
 const base={template_id:'workbook:monthly:june',period_start:'2026-06-01',scope_key:'property',status:'approved'};
 const rows=[{...base,id:'legacy',updated_at:'1',payload:{responses:{a:true,b:true}}},{...base,id:'manual',updated_at:'2',payload:{responses:{c:true}}}];
 const review=p=>p.id==='legacy'?{unverified_items:['a','b']}:null;
 const key='workbook:monthly:june|2026-06-01|property';
 assert.deepEqual([...approvedRoutineUnverifiedItems(rows,review).get(key)],['a','b']);
 rows.push({...base,id:'correction',updated_at:'3',payload:{responses:{a:false}}});
 assert.deepEqual([...approvedRoutineUnverifiedItems(rows,review).get(key)],['b']);
});
