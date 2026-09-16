import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
const root=fileURLToPath(new URL('../src/',import.meta.url));
const order={location_id:'location-409',issue:'Sink leaking',display_id:'WO-test',category:'Plumbing',priority:'Medium'};
function fixture(body,config={}) {
  const writes=[],clients=[];
  const profile={active:true,role:'Front Desk',full_name:'Shared Desk',...config.profile};
  const assets=config.assets??[{id:'asset',location_id:config.wrongAsset?'other':'location-409',name:'Verified sink',asset_type:'Plumbing',active:true}];
  const db={from(table){return {
    select(){return this;},eq(){return this;},in(){return this;},
    then(resolve){return Promise.resolve({data:table==='locations'?(config.noLocation?[]:[{id:'location-409',name:'Room 409'}]):assets,error:config.lookupError?{message:'Unavailable'}:null}).then(resolve);},
    limit:async()=>({data:table==='assets'?assets:(config.existing||[]),error:(table==='assets'?config.assetLookupError:config.duplicateError)?{message:'Unavailable'}:null}),
    insert:async rows=>{writes.push(...rows);return {error:config.insertError?{message:'Rejected'}:null};},
  };}};
  function load(file) {
    const exports={};
    vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://test.invalid',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'public-test'}},
      require(name){
        if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
        if(name==='@supabase/supabase-js')return {createClient:(url,key,options)=>{clients.push({key,options});return db;}};
        if(name==='@/lib/server/request-auth')return {authenticatedUser:async()=>config.unauthorized?null:{user:{id:'shared-id',email:'desk@example.invalid'},profile}};if(name==='server-only')return {};
        let target=name.startsWith('@/')?path.join(root,name.slice(2)):path.resolve(path.dirname(file),name);if(!existsSync(target))target+='.ts';return load(target);
      },
    });return exports;
  }
  return {writes,clients,handler:load(path.join(root,'app/api/work-orders/route.ts')).POST,request:{headers:new Headers({authorization:'Bearer caller-token'}),json:async()=>{if(config.badJson)throw new SyntaxError('bad');return body;}}};
}
for(const name of [undefined,'','   ',123,'1234','Scott123'])test(`front desk requires first name ${JSON.stringify(name)}`,async()=>{
  const f=fixture({orders:[order],staff_first_name:name});assert.equal((await f.handler(f.request)).status,400);assert.equal(f.writes.length,0);
});
for(const name of ['Scott','María','Anne-Marie','李'])test(`first name ${name} is stored with the shared account identity`,async()=>{
  const f=fixture({orders:[{...order,created_by:'spoof',creator_name:'Spoof',status:'Closed'}],staff_first_name:name});
  assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes[0].creator_name,name);assert.equal(f.writes[0].submitted_by_name,name);
  assert.equal(f.writes[0].created_by,'shared-id');assert.equal(f.writes[0].creator_account_user_id,'shared-id');assert.equal(f.writes[0].status,'Pending Verification');
  assert.equal(f.clients[0].key,'public-test');assert.equal(f.clients[0].options.global.headers.Authorization,'Bearer caller-token');
});
test('batch submissions attribute every ticket to the same first name and account',async()=>{
  const f=fixture({orders:[order,{...order,issue:'Door sticks'}],staff_first_name:' Scott '});
  assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes.length,2);assert.ok(f.writes.every(row=>row.creator_name==='Scott'&&row.created_by==='shared-id'));
});
test('engineer identity comes from the signed-in profile, not submitted names',async()=>{
  const f=fixture({orders:[order],staff_first_name:'Spoof'},{profile:{role:'Engineer',full_name:'Scott Pickering'}});
  assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes[0].creator_name,'Scott Pickering');assert.equal(f.writes[0].submitted_by_name,null);
});
for(const config of [{unauthorized:true},{noLocation:true},{lookupError:true}])test(`creation rejects unavailable authority or target ${JSON.stringify(config)}`,async()=>{
  const f=fixture({orders:[{...order,asset_id:'asset'}],staff_first_name:'Scott'},config);assert.ok((await f.handler(f.request)).status>=400);assert.equal(f.writes.length,0);
});
for(const orders of [[],[null],[{...order,issue:' '}],[order,{...order,location_id:''}]])test(`invalid batch is rejected without partial insert ${JSON.stringify(orders)}`,async()=>{
  const f=fixture({orders,staff_first_name:'Scott'});assert.equal((await f.handler(f.request)).status,400);assert.equal(f.writes.length,0);
});
test('first-name field is required and all three creation paths use the common submission function',()=>{
  const source=readFileSync(path.join(root,'app/work-orders/page.tsx'),'utf8');
  assert.match(source,/Your first name/);assert.match(source,/<input required maxLength=\{80\}/);
  assert.equal((source.match(/await submitWorkOrders\(/g)||[]).length,3);
  assert.equal(/\.insert\(/.test(source),false);
});
test('duplicate tickets inside one batch are rejected without partial insertion',async()=>{
  const f=fixture({orders:[order,{...order,issue:'The sink is leaking'}],staff_first_name:'Scott'});
  assert.equal((await f.handler(f.request)).status,409);assert.equal(f.writes.length,0);
});
test('a saved matching ticket blocks any new ticket in the batch',async()=>{
  const f=fixture({orders:[{...order,issue:'Door sticks'},order],staff_first_name:'Scott'},{existing:[{...order,id:'existing-id',status:'Open'}]});
  const result=await f.handler(f.request);assert.equal(result.status,409);assert.equal(result.body.existing_work_order_id,'existing-id');assert.equal(f.writes.length,0);
});
for(const config of [{duplicateError:true},{existing:Array.from({length:1000},()=>({...order,issue:'Different task'}))}])test(`incomplete duplicate lookup fails closed: ${config.duplicateError?'error':'result limit reached'}`,async()=>{
  const f=fixture({orders:[order],staff_first_name:'Scott'},config);assert.equal((await f.handler(f.request)).status,503);assert.equal(f.writes.length,0);
});

test('front desk supplied equipment, category and priority cannot override server guesses',async()=>{
  const f=fixture({orders:[{...order,asset_id:'spoof',asset_name:'Fake TV',category:'Safety',priority:'Urgent'}],staff_first_name:'Scott'});
  assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes[0].asset_id,'asset');assert.equal(f.writes[0].asset_name,'Verified sink');assert.equal(f.writes[0].category,'Plumbing');assert.equal(f.writes[0].priority,'Medium');
});
test('front desk HVAC defaults to High based on location equipment and issue',async()=>{
  const f=fixture({orders:[{...order,issue:'not cooling',priority:'Low'}],staff_first_name:'Scott'},{assets:[{id:'vtac',location_id:'location-409',name:'VTAC – Room 409',asset_type:'VTAC',active:true}]});
  assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes[0].asset_id,'vtac');assert.equal(f.writes[0].priority,'High');
});
test('front desk cannot assign unlocated, retired or other-room equipment',async()=>{
  const f=fixture({orders:[{...order,issue:'not cooling',asset_id:'other'}],staff_first_name:'Scott'},{assets:[{id:'other',location_id:'other-room',name:'VTAC',asset_type:'VTAC'},{id:'retired',location_id:'location-409',name:'VTAC',asset_type:'VTAC',active:false},{id:'unlocated',location_id:null,name:'VTAC',asset_type:'VTAC'}]});
  assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes[0].asset_id,null);assert.equal(f.writes[0].category,'HVAC');assert.equal(f.writes[0].priority,'High');
});
for(const config of [{assetLookupError:true},{assets:Array.from({length:1000},(_,i)=>({id:String(i),location_id:'location-409',name:'Sink',asset_type:'Plumbing'}))}])test('incomplete equipment lookup prevents partial or guessed writes',async()=>{
  const f=fixture({orders:[order],staff_first_name:'Scott'},config);assert.equal((await f.handler(f.request)).status,503);assert.equal(f.writes.length,0);
});
test('engineering assignment still rejects equipment from another room',async()=>{
  const f=fixture({orders:[{...order,asset_id:'asset'}]},{profile:{role:'Engineer'},wrongAsset:true});assert.equal((await f.handler(f.request)).status,400);assert.equal(f.writes.length,0);
});

test('the observed system_admin role can create a work order',async()=>{
  const f=fixture({orders:[order]},{profile:{role:'system_admin',full_name:'Engineer'}});assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes[0].creator_name,'Engineer');
});
