import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { poolLogInput, validLogDate, poolLocationValue, prepareMcpPoolLogInput, poolClosureReasons, poolReadings, poolReadingWarnings, mergePoolLogBody, PoolLogConflictError, poolLogStatus, sampleLocations } from '../src/lib/pool-log.ts';
import { fetchAllPages } from '../src/lib/server/paginated-query.ts';
const facilityId='00000000-0000-0000-0000-000000000001';
const input={pool_facility_id:facilityId,log_date:'2026-09-15',ph_am:7.4,sanitizer_am:4,sample_location_am:'shallow',temperature_f:84,flow_rate_gpm:60,main_drain_visible:true,filter_backwashed:false,requires_attention:false,closure_condition:false,closure_reason:'',remarks:''};
test('pool input preserves explicit false Booleans, unmeasured fields, and measured zero',()=>{
 const row=poolLogInput({...input,flow_rate_gpm:0,created_by:'spoof'});assert.equal(row.flow_rate_gpm,0);assert.equal(row.ph_pm,null);assert.equal(row.main_drain_visible,true);assert.equal(row.filter_backwashed,false);assert.equal(row.requires_attention,false);assert.equal(row.closure_condition,false);assert.equal('created_by' in row,false);
});
test('selected bromine bands are stored as labels and closure-triggering bands force a closure record',()=>{
 const row=poolLogInput({...input,sanitizer_am:null,sanitizer_band_am:'1-2',closure_reason:'Bromine level outside the safe range.'});
 assert.equal(row.sanitizer_am,null);assert.equal(row.sanitizer_band_am,'1-2');assert.equal(row.closure_condition,true);
 assert.equal(poolLocationValue(row,'sanitizer_shallow_am'),'1-2');
 assert.equal(poolLocationValue(row,'sanitizer_deep_am'),'1-2');
});
test('closure thresholds include zero and both ends of the selected pH range',()=>{
 for(const [ph,band] of [[7.0,'2-4'],[8.0,'2-4'],[7.4,'0'],[7.4,'1-2'],[7.4,'7.5-15'],[7.4,'10-20']]){
  const row=poolLogInput({...input,ph_am:ph,sanitizer_am:null,sanitizer_band_am:band,closure_reason:'Reading requires the pool to remain closed.'});
  assert.equal(row.closure_condition,true,`${ph}/${band}`);
  assert.ok(poolClosureReasons(row).length);
 }
 for(const band of ['2-4','3-6','5-10']){
  const row=poolLogInput({...input,sanitizer_am:null,sanitizer_band_am:band});
  assert.equal(row.closure_condition,false,band);
 }
 for(const ph of [7.2,7.8]){
  const row=poolLogInput({...input,ph_am:ph,sanitizer_am:null,sanitizer_band_am:'2-4'});
  assert.equal(row.closure_condition,false,String(ph));
 }
});
test('invalid bromine bands and simultaneous numeric/band entries are rejected',()=>{
 assert.throws(()=>poolLogInput({...input,sanitizer_am:null,sanitizer_band_am:'4-8'}),/valid bromine range/);
 assert.throws(()=>poolLogInput({...input,sanitizer_band_am:'1-2'}),/both a numeric bromine reading and a selected range/);
});
test('middle of pool is no longer a sample location; each period records shallow or deep',()=>{
 assert.deepEqual(sampleLocations.map(([value])=>value),['shallow','deep']);
 assert.throws(()=>poolLogInput({...input,sample_location_am:'middle'}),/shallow or deep/);
 const row=poolLogInput({...input,ph_pm:7.5,sanitizer_pm:5,sample_location_pm:'deep'});
 assert.equal(row.sample_location_am,'shallow');
 assert.equal(row.sample_location_pm,'deep');
 assert.throws(()=>poolLogInput({...input,ph_pm:7.5,sanitizer_pm:5}),/PM sample was taken/);
 const historical=poolLogInput({...input,sample_location_am:'middle'},{sample_location_am:'middle'});
 assert.equal(historical.sample_location_am,'middle');
});
test('closure at pH 8.0 requires a recorded reason',()=>{
 assert.ok(poolClosureReasons({...input,ph_am:8.0}).length);
 assert.throws(()=>poolLogInput({...input,ph_am:8.0}),/pool must be closed: AM pH 8\.0/i);
 const row=poolLogInput({...input,ph_am:8.0,closure_reason:'pH is above the approved operating range.'});
 assert.equal(row.closure_condition,true);
 assert.equal(row.closure_reason,'pH is above the approved operating range.');
});
test('daily checks (temperature, flow, drain, backwash) are required and chlorine/CYA are not pool readings',()=>{
 assert.throws(()=>poolLogInput({...input,main_drain_visible:null}),/daily checks.*main drain visible/i);
 assert.throws(()=>poolLogInput({...input,filter_backwashed:null}),/daily checks.*filter backwashed/i);
 assert.throws(()=>poolLogInput({...input,temperature_f:null}),/daily checks.*water temperature/i);
 assert.throws(()=>poolLogInput({...input,flow_rate_gpm:undefined}),/daily checks.*flow rate/i);
 assert.equal(poolReadings.some(([,label])=>/chlorine|cyanuric/i.test(label)),false);
 const row=poolLogInput({...input,combined_chlorine_ppm:3,cyanuric_acid_ppm:9});
 assert.equal('combined_chlorine_ppm' in row,false);
 assert.equal('cyanuric_acid_ppm' in row,false);
});
test('pH and bromine come from one sample: a partial sample is rejected',()=>{
 assert.throws(()=>poolLogInput({...input,sanitizer_am:null}),/AM sample needs its bromine/);
 assert.throws(()=>poolLogInput({...input,ph_am:null}),/AM sample needs its pH/);
});
test('main drain not visible or water above 104F closes the pool; low flow is flagged',()=>{
 assert.match(poolClosureReasons({...input,main_drain_visible:false}).join(),/Main drain is not visible/);
 assert.match(poolClosureReasons({...input,temperature_f:105}).join(),/above 104/);
 assert.equal(poolClosureReasons({...input,temperature_f:104}).length,0);
 assert.throws(()=>poolLogInput({...input,main_drain_visible:false}),/pool must be closed: Main drain is not visible/);
 const closed=poolLogInput({...input,temperature_f:106,closure_reason:'Heater fault; pool closed.'});
 assert.equal(closed.closure_condition,true);
 assert.deepEqual(poolReadingWarnings({flow_rate_gpm:40}),['Flow rate 40 GPM is below the required 48 GPM']);
 assert.equal(poolReadingWarnings({flow_rate_gpm:48}).length,0);
 assert.equal(poolLogInput({...input,flow_rate_gpm:40}).closure_condition,false);
});
test('a later PM sample merges without erasing the saved AM sample or daily checks',()=>{
 const saved={...poolLogInput(input),id:'saved',revision:3};
 const merged=mergePoolLogBody(saved,{pool_facility_id:facilityId,log_date:input.log_date,ph_pm:7.6,sanitizer_band_pm:'3-6',sample_location:'deep'},false);
 const row=poolLogInput(merged,saved);
 assert.equal(row.ph_am,7.4);assert.equal(row.sanitizer_am,4);assert.equal(row.sample_location_am,'shallow');
 assert.equal(row.ph_pm,7.6);assert.equal(row.sanitizer_band_pm,'3-6');assert.equal(row.sample_location_pm,'deep');
 assert.equal(row.temperature_f,84);assert.equal(row.flow_rate_gpm,60);assert.equal(row.main_drain_visible,true);
 assert.equal(poolLogStatus(row).pm_sample_recorded,true);
 assert.deepEqual(poolLogStatus({ph_am:7.4,sanitizer_am:4}).daily_checks_missing,['Water temperature','Flow rate','Main drain visible','Filter backwashed']);
});
test('only System Administrators can change a saved value',()=>{
 const saved=poolLogInput(input);
 assert.throws(()=>mergePoolLogBody(saved,{...input,ph_am:7.6},false),(error)=>error instanceof PoolLogConflictError&&/AM pH \(saved as 7\.4\)/.test(error.message));
 assert.throws(()=>mergePoolLogBody(saved,{...input,temperature_f:90},false),PoolLogConflictError);
 assert.equal(mergePoolLogBody(saved,{...input,ph_am:7.6},true).ph_am,7.6);
 assert.equal(mergePoolLogBody(saved,{log_date:input.log_date,pool_facility_id:facilityId,ph_am:null},false).ph_am,7.4);
 const remarks=mergePoolLogBody({...saved,remarks:'AM ok'},{...input,remarks:'PM ok'},false);
 assert.equal(remarks.remarks,'AM ok\nPM ok');
});
for(const change of [{log_date:'2026-02-30'},{ph_am:15},{sanitizer_am:-1},{ph_am:'7.4'},{flow_rate_gpm:Infinity},{main_drain_visible:'yes'},{remarks:{}},{requires_attention:'false'}])test(`invalid pool input rejected: ${JSON.stringify(change)}`,()=>assert.throws(()=>poolLogInput({...input,...change})));
test('date validation rejects impossible dates and retains leap days',()=>{assert.equal(validLogDate('2028-02-29'),true);assert.equal(validLogDate('2026-02-29'),false);});
test('MCP pool save maps read date and pool name to the existing API fields',()=>{
 const facilities=[{id:facilityId,pool_name:'Indoor Pool',facility_name:'Residence Inn Indoor Pool'}];
 const payload=prepareMcpPoolLogInput({date:'2026-09-29',pool:'indoor pool',ph_am:7.4,main_drain_visible:true,filter_backwashed:false,requires_attention:false,closure_condition:false},facilities);
 assert.equal(payload.log_date,'2026-09-29');
 assert.equal(payload.pool_facility_id,facilityId);
 assert.equal(payload.requires_attention,false);
 assert.equal(payload.closure_condition,false);
 assert.equal('date' in payload,false);
 assert.equal('pool' in payload,false);
});
test('MCP pool save accepts the facility object returned by pool-log read',()=>{
 const facilities=[{id:facilityId,pool_name:'Indoor Pool'}];
 const payload=prepareMcpPoolLogInput({log_date:'2026-09-29',facility:facilities[0],main_drain_visible:true,filter_backwashed:false,requires_attention:false,closure_condition:false},facilities);
 assert.equal(payload.pool_facility_id,facilityId);
 assert.equal(payload.requires_attention,false);
 assert.equal(payload.closure_condition,false);
});
test('MCP pool save accepts omitted checks but rejects non-Boolean values',()=>{
 const facilities=[{id:facilityId,pool_name:'Indoor Pool'}];
 const payload=prepareMcpPoolLogInput({date:'2026-09-29',pool:'Indoor Pool',ph_pm:7.4,sanitizer_band_pm:'3-6'},facilities);
 assert.equal('requires_attention' in payload,false);
 assert.equal('main_drain_visible' in payload,false);
 for(const field of ['requires_attention','closure_condition','main_drain_visible','filter_backwashed']){
  assert.throws(()=>prepareMcpPoolLogInput({date:'2026-09-29',pool:'Indoor Pool',[field]:'yes'},facilities),new RegExp(`true or false for ${field.replaceAll('_',' ')}`));
 }
});
const mcpDay={date:'2026-09-29',pool:'Indoor Pool',ph_am:7.4,sanitizer_band_am:'3-6',sample_location_am:'shallow',temperature_f:84,flow_rate_gpm:60,main_drain_visible:true,filter_backwashed:false};
test('MCP pool writes need a reason when a log is marked closed',()=>{
 const facilities=[{id:facilityId,pool_name:'Indoor Pool'}];
 const payload=prepareMcpPoolLogInput({...mcpDay,closure_condition:true},facilities);
 assert.throws(()=>poolLogInput(payload),/reason whenever the pool is closed/i);
});
test('MCP pool test entry adds a remark and still needs a real sample',()=>{
 const facilities=[{id:facilityId,pool_name:'Indoor Pool'}];
 const payload=prepareMcpPoolLogInput({...mcpDay,test_entry:true},facilities);
 assert.equal(payload.remarks,'Test entry');
 assert.equal('test_entry' in payload,false);
 assert.equal(poolLogInput(payload).remarks,'Test entry');
 assert.throws(()=>poolLogInput(prepareMcpPoolLogInput({date:'2026-09-29',pool:'Indoor Pool',test_entry:true},facilities)),/Record the AM or PM water sample/);
});
test('MCP pool save still rejects an empty entry',()=>{
 const facilities=[{id:facilityId,pool_name:'Indoor Pool'}];
 const payload=prepareMcpPoolLogInput({date:'2026-09-29',pool:'Indoor Pool',temperature_f:84,flow_rate_gpm:60,main_drain_visible:true,filter_backwashed:false},facilities);
 assert.throws(()=>poolLogInput(payload),/Record the AM or PM water sample/);
});
test('MCP pool save rejects ambiguous pool names and non-ISO dates before saving',()=>{
 const facilities=[{id:facilityId,pool_name:'Indoor Pool'},{id:'00000000-0000-0000-0000-000000000002',pool_name:'Indoor Pool'}];
 assert.throws(()=>prepareMcpPoolLogInput({date:'September 29',pool:'Indoor Pool'},facilities),/YYYY-MM-DD/);
 assert.throws(()=>prepareMcpPoolLogInput({date:'2026-09-29',pool:'Indoor Pool'},facilities),/More than one active pool/);
});
const root=fileURLToPath(new URL('../src/',import.meta.url));
function fixture(config={}) {
 const calls=[],writes=[];
 const db={from(table){const filters=[];let changed;
  const q={select(){return q;},eq(key,value){filters.push([key,value]);return q;},order(){return table==='pool_facilities'?Promise.resolve({data:[{id:facilityId,pool_name:'Indoor Pool'}],error:null}):q;},
   range(from,to){q.from=from;q.to=to;return q;},
   then(resolve,reject){
    if(table!=='pool_daily_logs')return Promise.resolve({data:[],error:null}).then(resolve,reject);
    calls.push({table,filters});
    if(config.historyError&&q.from>=1000)return Promise.resolve({data:null,error:new Error('Unavailable')}).then(resolve,reject);
    const all=config.history||[];
    return Promise.resolve({data:all.slice(q.from??0,(q.to??999)+1),error:null}).then(resolve,reject);
   },
   maybeSingle:async()=>{calls.push({table,filters});return table==='pool_facilities'?{data:config.noFacility?null:{id:facilityId},error:config.lookupError?{message:'Unavailable'}:null}:{data:config.existing||null,error:config.readError?{message:'Unavailable'}:null};},
   insert(row){writes.push(row);changed=row;return q;},update(row){writes.push(row);changed=row;return q;},
   single:async()=>config.dbError?{data:null,error:config.dbError}:config.saveError||config.concurrent?{data:null,error:{code:config.concurrent?'PGRST116':'23505'}}:{data:{...changed,id:'saved',revision:2},error:null}};
  return q;
 }};
 function load(file){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://test.invalid',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'fake',SUPABASE_SERVICE_ROLE_KEY:'fake'}},
  require(name){
   if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
   if(name==='@/lib/server/request-auth')return {authenticatedUser:async()=>config.unauthorized?null:{user:{id:'actor'},profile:{role:config.role||'system_admin',full_name:'Scott Pickering'},admin:db}};
   if(name==='@/lib/server/paginated-query')return {fetchAllPages};
   if(name==='server-only')return {};
   if(name==='@supabase/supabase-js')return {createClient:function(){return {auth:{getUser:function(){return {data:{user:{id:'actor'}},error:null}}}}}};
   let target=name.startsWith('@/')?path.join(root,name.slice(2)):path.resolve(path.dirname(file),name);if(!existsSync(target))target+='.ts';return load(target);
  }});return exports;
 }
 return {handlers:load(path.join(root,'app/api/pool-log/route.ts')),calls,writes,request:{nextUrl:new URL('https://test.invalid/api/pool-log?date=2026-09-15'),headers:new Headers({authorization:'Bearer fake'}),json:async()=>({...input,...config.body})}};
}
for(const config of [{unauthorized:true},{role:'Front Desk'},{role:'Housekeeping'}])test(`pool writes reject unavailable authority ${JSON.stringify(config)}`,async()=>{
 const f=fixture(config);assert.equal((await f.handlers.POST(f.request)).status,config.unauthorized?401:403);assert.equal(f.writes.length,0);
});
test('pool save uses authenticated actor and profile initials, never submitted attribution',async()=>{
 const f=fixture({body:{created_by:'spoof',updated_by:'spoof',completed_by_initials:'XX'}});assert.equal((await f.handlers.POST(f.request)).status,200);assert.equal(f.writes[0].created_by,'actor');assert.equal(f.writes[0].updated_by,'actor');assert.equal(f.writes[0].completed_by_initials,'SP');
 assert.ok(f.calls.every(c=>c.filters.some(([key,value])=>key==='hotel_id'&&value==='c81ad01a-7a9f-4880-ac1c-5e849f30bad6')));
});
test('pool API persists selected bromine ranges and forces closure for unsafe readings',async()=>{
 const f=fixture({body:{ph_am:7.4,sanitizer_am:null,sanitizer_band_am:'10-20',sample_location_am:'deep',closure_condition:false,closure_reason:'Bromine level is outside the approved range.'}});
 const result=await f.handlers.POST(f.request);
 assert.equal(result.status,200);
 assert.equal(f.writes[0].sanitizer_band_am,'10-20');
 assert.equal(f.writes[0].sample_location_am,'deep');
 assert.equal(result.body.closure_required,true);
 assert.match(result.body.closure_reasons.join(),/AM bromine/);
 assert.equal(f.writes[0].closure_condition,true);
});
test('pool history returns every saved entry across database pages',async()=>{
 const history=Array.from({length:1001},(_,index)=>({id:`log-${index}`,log_date:'2026-09-15'}));
 const f=fixture({history});
 f.request.nextUrl=new URL(`https://test.invalid/api/pool-log?history=1&facility=${facilityId}`);
 const result=await f.handlers.GET(f.request);
 assert.equal(result.status,200);
 assert.equal(result.body.history.length,1001);
 assert.equal(result.body.history[1000].id,'log-1000');
 assert.ok(f.calls.filter((call)=>call.table==='pool_daily_logs').every((call)=>
  call.filters.some(([key,value])=>key==='hotel_id'&&value==='c81ad01a-7a9f-4880-ac1c-5e849f30bad6')
  &&call.filters.some(([key,value])=>key==='pool_facility_id'&&value===facilityId)));
});
test('pool history surfaces later-page errors instead of returning a partial log',async()=>{
 const history=Array.from({length:1001},(_,index)=>({id:`log-${index}`,log_date:'2026-09-15'}));
 const f=fixture({history,historyError:true});
 f.request.nextUrl=new URL(`https://test.invalid/api/pool-log?history=1&facility=${facilityId}`);
 const result=await f.handlers.GET(f.request);
 assert.equal(result.status,503);
 assert.equal(result.body.history,undefined);
});
for(const config of [{noFacility:true},{lookupError:true},{readError:true},{existing:{id:'saved',revision:2},body:{edit_mode:'replace',expected_revision:1}}])test(`unsafe pool save rejected ${JSON.stringify(config)}`,async()=>{
 const f=fixture(config);assert.ok((await f.handlers.POST(f.request)).status>=400);assert.equal(f.writes.length,0);
});
test('a stale revision on a new pool log still saves the readings',async()=>{
 const f=fixture({body:{expected_revision:2}});
 const result=await f.handlers.POST(f.request);
 assert.equal(result.status,200);
 assert.equal(f.writes.length,1);
});
test('pool edit checks revision and preserves original creator',async()=>{
 const f=fixture({existing:{id:'saved',revision:2},body:{expected_revision:2,created_by:'spoof'}});assert.equal((await f.handlers.POST(f.request)).status,200);assert.equal(f.writes[0].created_by,undefined);
});
test('an engineer adds the PM sample by voice without erasing the saved AM sample',async()=>{
 const f=fixture({role:'Engineer',existing:{...poolLogInput(input),id:'saved',revision:2,completed_by_initials:'JD'}});
 f.request.json=async()=>({pool_facility_id:facilityId,log_date:input.log_date,ph_pm:7.6,sanitizer_band_pm:'3-6',sample_location_pm:'deep',remarks:''});
 const result=await f.handlers.POST(f.request);
 assert.equal(result.status,200);
 assert.equal(f.writes.length,1);
 assert.equal(f.writes[0].ph_am,7.4);assert.equal(f.writes[0].sanitizer_am,4);assert.equal(f.writes[0].sample_location_am,'shallow');
 assert.equal(f.writes[0].ph_pm,7.6);assert.equal(f.writes[0].sample_location_pm,'deep');
 assert.equal(f.writes[0].temperature_f,84);
 assert.equal(f.writes[0].completed_by_initials,'JD / SP');
 assert.equal(result.body.status.pm_sample_recorded,true);
});
test('an engineer cannot change a saved value; nothing is written',async()=>{
 const f=fixture({role:'Engineer',existing:{...poolLogInput(input),id:'saved',revision:2,completed_by_initials:'JD'},body:{ph_am:7.6}});
 const result=await f.handlers.POST(f.request);
 assert.equal(result.status,403);
 assert.match(result.body.error,/only a System Administrator/);
 assert.equal(f.writes.length,0);
});
test('resending the saved readings is reported as unchanged',async()=>{
 const f=fixture({role:'Engineer',existing:{...poolLogInput(input),id:'saved',revision:2,completed_by_initials:'JD'}});
 const result=await f.handlers.POST(f.request);
 assert.equal(result.status,200);
 assert.equal(result.body.unchanged,true);
 assert.equal(f.writes.length,0);
});
test('a System Administrator correction on the web page replaces the saved log',async()=>{
 const f=fixture({existing:{...poolLogInput(input),id:'saved',revision:2,completed_by_initials:'JD'},body:{edit_mode:'replace',expected_revision:2,ph_am:7.6}});
 const result=await f.handlers.POST(f.request);
 assert.equal(result.status,200);
 assert.equal(f.writes[0].ph_am,7.6);
});
test('engineers can still create a new pool log',async()=>{
 const f=fixture({role:'Engineer'});
 assert.equal((await f.handlers.POST(f.request)).status,200);
 assert.equal(f.writes.length,1);
});
test('pool log read identifies System Administrator saved-log edit access',async()=>{
 const admin=fixture({role:'System Administrator'});
 const operator=fixture({role:'Engineer'});
 assert.equal((await admin.handlers.GET(admin.request)).body.can_edit_saved,true);
 assert.equal((await operator.handlers.GET(operator.request)).body.can_edit_saved,false);
});
for(const config of [{saveError:true},{concurrent:true,existing:{id:'saved',revision:2},body:{expected_revision:2}}])test('conflicting pool saves report a conflict',async()=>{
 const f=fixture(config);assert.equal((await f.handlers.POST(f.request)).status,409);
});
test('housekeeping cannot access pool logs (dashboard access required)',async()=>{
 const f=fixture({role:'Housekeeping'});const result=await f.handlers.GET(f.request);assert.equal(result.status,403);assert.equal(f.writes.length,0);
});
test('pool API blocks saves missing required checks or a closure reason',async()=>{
 for(const body of [{main_drain_visible:null},{filter_backwashed:null},{ph_am:8.0}]){
  const f=fixture({body});
  const result=await f.handlers.POST(f.request);
  assert.equal(result.status,400);
  assert.equal(f.writes.length,0);
 }
});
test('pool-log UI flags closures, requires daily checks, and offers only shallow or deep',()=>{
 const page=readFileSync(new URL('../src/app/engineering/pool-log/page.tsx',import.meta.url),'utf8');
 assert.match(page,/View entire pool log/);
 assert.doesNotMatch(page,/Middle of pool/);
 assert.match(page,/sampleLocations\.map/);
 assert.match(page,/The pool must be closed/);
 assert.match(page,/Still needed before saving/);
 assert.match(page,/Daily checks/);
 assert.match(page,/Reason pool is closed \(required\)/);
 assert.doesNotMatch(page,/Combined chlorine|Cyanuric acid/i);
});
test('daily pool form has exactly one pH and sanitizer result for AM and PM',()=>{
 const row=poolLogInput({...input,ph_pm:7.5,sanitizer_pm:5,sample_location_pm:'shallow',ph_shallow_am:8,ph_deep_am:9});
 assert.equal(row.ph_am,7.4);assert.equal(row.ph_pm,7.5);assert.equal(row.sanitizer_am,4);assert.equal(row.sanitizer_pm,5);assert.equal('ph_shallow_am' in row,false);assert.equal('ph_deep_am' in row,false);
});

test('one sample is recorded for both shallow and deep while historical values remain',()=>{
 const row=poolLogInput({...input,ph_pm:7.5,sanitizer_pm:5,sample_location_pm:'deep'});
 assert.equal(poolLocationValue(row,'ph_shallow_am'),7.4);
 assert.equal(poolLocationValue(row,'ph_deep_am'),7.4);
 assert.equal(poolLocationValue(row,'sanitizer_shallow_pm'),5);
 assert.equal(poolLocationValue(row,'sanitizer_deep_pm'),5);
 assert.equal(poolLocationValue(row,'ph_middle_am'),null);
 assert.equal(poolLocationValue({...row,ph_deep_am:7.2},'ph_deep_am'),7.2);
});
test('a reading requires a valid sample location',()=>{
 assert.throws(()=>poolLogInput({...input,sample_location_am:''}),/AM sample was taken/);
 assert.throws(()=>poolLogInput({...input,sample_location_am:'both'}),/AM sample was taken/);
});
test('database failures are reported instead of a generic conflict',async()=>{
 const missing=fixture({dbError:{code:'PGRST204',message:"Could not find the 'closure_reason' column in the schema cache"}});
 const missingResult=await missing.handlers.POST(missing.request);
 assert.equal(missingResult.status,503);
 assert.match(missingResult.body.error,/missing the latest pool-log update/);
 const rejected=fixture({dbError:{code:'P0001',message:'Only a System Administrator can change saved pool-log values'}});
 const rejectedResult=await rejected.handlers.POST(rejected.request);
 assert.equal(rejectedResult.status,400);
 assert.match(rejectedResult.body.error,/Only a System Administrator/);
 const unknown=fixture({dbError:{code:'XX000',message:'boom'}});
 assert.equal((await unknown.handlers.POST(unknown.request)).status,500);
});
