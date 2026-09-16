import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { poolLogInput, validLogDate, poolLocationValue } from '../src/lib/pool-log.ts';
const facilityId='00000000-0000-0000-0000-000000000001';
const input={pool_facility_id:facilityId,log_date:'2026-09-15',ph_am:7.4,sanitizer_am:4,sample_location_am:'shallow',requires_attention:false,closure_condition:false,remarks:''};
test('pool input preserves unmeasured fields as null and measured zero as zero',()=>{
 const row=poolLogInput({...input,flow_rate_gpm:0,created_by:'spoof'});assert.equal(row.flow_rate_gpm,0);assert.equal(row.ph_pm,null);assert.equal(row.main_drain_visible,null);assert.equal('created_by' in row,false);
});
for(const change of [{log_date:'2026-02-30'},{ph_am:15},{sanitizer_am:-1},{ph_am:'7.4'},{flow_rate_gpm:Infinity},{main_drain_visible:'yes'},{remarks:{}},{requires_attention:'false'}])test(`invalid pool input rejected: ${JSON.stringify(change)}`,()=>assert.throws(()=>poolLogInput({...input,...change})));
test('date validation rejects impossible dates and retains leap days',()=>{assert.equal(validLogDate('2028-02-29'),true);assert.equal(validLogDate('2026-02-29'),false);});
const root=fileURLToPath(new URL('../src/',import.meta.url));
function fixture(config={}) {
 const calls=[],writes=[];
 const db={from(table){const filters=[];let changed;
  const q={select(){return q;},eq(key,value){filters.push([key,value]);return q;},order:async()=>({data:[{id:facilityId,pool_name:'Indoor Pool'}],error:null}),
   maybeSingle:async()=>{calls.push({table,filters});return table==='pool_facilities'?{data:config.noFacility?null:{id:facilityId},error:config.lookupError?{message:'Unavailable'}:null}:{data:config.existing||null,error:config.readError?{message:'Unavailable'}:null};},
   insert(row){writes.push(row);changed=row;return q;},update(row){writes.push(row);changed=row;return q;},
   single:async()=>config.saveError||config.concurrent?{data:null,error:{code:config.concurrent?'PGRST116':'23505'}}:{data:{...changed,id:'saved',revision:2},error:null}};
  return q;
 }};
 function load(file){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://test.invalid',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'fake',SUPABASE_SERVICE_ROLE_KEY:'fake'}},
  require(name){
   if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
   if(name==='@/lib/server/request-auth')return {authenticatedUser:async()=>config.unauthorized?null:{user:{id:'actor'},profile:{role:config.role||'system_admin',full_name:'Scott Pickering'},admin:db}};
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
for(const config of [{noFacility:true},{lookupError:true},{readError:true},{existing:{id:'saved',revision:2},body:{expected_revision:1}}])test(`unsafe pool save rejected ${JSON.stringify(config)}`,async()=>{
 const f=fixture(config);assert.ok((await f.handlers.POST(f.request)).status>=400);assert.equal(f.writes.length,0);
});
test('pool edit checks revision and preserves original creator',async()=>{
 const f=fixture({existing:{id:'saved',revision:2},body:{expected_revision:2,created_by:'spoof'}});assert.equal((await f.handlers.POST(f.request)).status,200);assert.equal(f.writes[0].created_by,undefined);
});
for(const config of [{saveError:true},{concurrent:true,existing:{id:'saved',revision:2},body:{expected_revision:2}}])test('conflicting pool saves report a conflict',async()=>{
 const f=fixture(config);assert.equal((await f.handlers.POST(f.request)).status,409);
});
test('housekeeping cannot access pool logs (dashboard access required)',async()=>{
 const f=fixture({role:'Housekeeping'});const result=await f.handlers.GET(f.request);assert.equal(result.status,403);assert.equal(f.writes.length,0);
});

test('daily pool form has exactly one pH and sanitizer result for AM and PM',()=>{
 const row=poolLogInput({...input,ph_pm:7.5,sanitizer_pm:5,sample_location_pm:'deep',ph_shallow_am:8,ph_deep_am:9});
 assert.equal(row.ph_am,7.4);assert.equal(row.ph_pm,7.5);assert.equal(row.sanitizer_am,4);assert.equal(row.sanitizer_pm,5);assert.equal('ph_shallow_am' in row,false);assert.equal('ph_deep_am' in row,false);
});

test('one sample appears only at the selected location while historical values remain',()=>{
 const row=poolLogInput({...input,ph_pm:7.5,sanitizer_pm:5,sample_location_pm:'deep'});
 assert.equal(poolLocationValue(row,'ph_shallow_am'),7.4);
 assert.equal(poolLocationValue(row,'ph_deep_am'),null);
 assert.equal(poolLocationValue(row,'ph_deep_pm'),7.5);
 assert.equal(poolLocationValue(row,'ph_shallow_pm'),null);
 assert.equal(poolLocationValue({...row,ph_deep_am:7.2},'ph_deep_am'),7.2);
});
test('a reading requires a valid sample location',()=>{
 assert.throws(()=>poolLogInput({...input,sample_location_am:''}));
 assert.throws(()=>poolLogInput({...input,sample_location_am:'both'}));
});
