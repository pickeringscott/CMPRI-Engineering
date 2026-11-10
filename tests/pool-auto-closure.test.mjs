import test from 'node:test';
import assert from 'node:assert/strict';
import {poolLogInput,poolCurrentClosureReasons} from '../src/lib/pool-log.ts';
const base={pool_facility_id:'00000000-0000-4000-8000-000000000001',log_date:'2026-09-15',ph_am:8,sanitizer_band_am:'0',temperature_f:84,flow_rate_gpm:60,main_drain_visible:true,filter_backwashed:false,requires_attention:false,closure_condition:false,closure_reason:'',remarks:''};
test('unsafe readings need no narrative and report every chemical failure',()=>{
 const row=poolLogInput(base);assert.equal(row.closure_condition,true);assert.equal(row.manual_closure,false);assert.equal(row.closure_reason,null);
 const reasons=poolCurrentClosureReasons(row).join('; ');assert.match(reasons,/pH 8\.0/);assert.match(reasons,/bromine 0/);
});
test('a new independent manual closure still requires a reason even when readings fail',()=>{
 assert.throws(()=>poolLogInput({...base,manual_closure:true}),/reason.*manually/i);
 const row=poolLogInput({...base,manual_closure:true,closure_reason:'Pump repair'});assert.equal(row.manual_closure,true);assert.equal(row.closure_reason,'Pump repair');
});
