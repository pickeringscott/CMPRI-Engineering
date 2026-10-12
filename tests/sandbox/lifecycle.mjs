import {readJsonResponse} from './http-diagnostics.mjs';
import {createClient} from '@supabase/supabase-js';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const out=new URL('../../.sandbox/',import.meta.url);
const keys=JSON.parse(readFileSync(new URL('local-keys.json',out)));
assert.match(keys.API_URL,/^http:\/\/(127\.0\.0\.1|localhost):54321$/);
const users=JSON.parse(readFileSync(new URL('synthetic-users.json',out)));
const admin=createClient(keys.API_URL,keys.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const results=[],sessions=new Map(),since=new Date(Date.now()-3600000).toISOString();
async function api(user,path,body){
  if(!sessions.has(user.id)){
    const client=createClient(keys.API_URL,keys.ANON_KEY,{auth:{persistSession:false}});
    const {data,error}=await client.auth.signInWithPassword({email:user.email,password:user.password});
    assert.ifError(error);sessions.set(user.id,data.session.access_token);
  }
  const response=await fetch('http://127.0.0.1:3112'+path,{method:body?'PATCH':'GET',headers:{Authorization:'Bearer '+sessions.get(user.id),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await readJsonResponse(response,path,body?'PATCH':'GET')};
}
const chief=users.find(u=>u.role==='chief_engineer'),technician=users.find(u=>u.role==='technician');
try{
  const {data,error}=await admin.from('work_orders').select('id,status,revision,technician_name').eq('created_by',users.find(u=>u.role==='housekeeping').id).eq('location_id',users.find(u=>u.role==='housekeeping').fixtures[0].location_id).single();
  assert.ifError(error);assert.ok(data,'Technician submission is a required lifecycle prerequisite');
  let current=data;
  assert.equal(current.status,'Pending Verification','Use a real submit-only request for approval');
  for(const user of users.filter(u=>!['chief_engineer','technician'].includes(u.role))){
    const denied=await api(user,'/api/work-orders/'+current.id,{status:'Open',expected_revision:current.revision});
    assert.ok([401,403].includes(denied.status),JSON.stringify(denied));
    results.push({phase:'unauthorized approval denied',role:user.label,status:denied.status,passed:true});
  }
  async function change(user,body,phase){
    const response=await api(user,'/api/work-orders/'+current.id,{...body,expected_revision:current.revision});
    assert.equal(response.status,200,JSON.stringify({phase,...response}));
    current=response.body.workOrder;
    results.push({phase,role:user.label,status:current.status,revision:current.revision,passed:true});
  }
  if(current.status!=='Open')await change(chief,{status:'Open'},'approve request');
  await change(technician,{technician_name:'Synthetic Maintenance Technician'},'technician self-claim');
  await change(technician,{status:'In Progress'},'technician start');
  await change(technician,{status:'Completed'},'technician complete');
  await change(chief,{status:'Closed'},'chief close');
  const persisted=await admin.from('work_orders').select('status,revision').eq('id',current.id).single();
  assert.ifError(persisted.error);assert.equal(persisted.data.status,'Closed');
  assert.equal(persisted.data.revision,current.revision);
}catch(error){results.push({phase:'ticket lifecycle',passed:false,error:String(error)});}
for(const user of users){
  try{
    const response=await api(user,'/api/work-orders/notifications?since='+encodeURIComponent(since));
    const eligible=['chief_engineer','technician'].includes(user.role);
    assert.equal(response.status,eligible?200:403,JSON.stringify(response.body));
    if(eligible)assert.ok(Array.isArray(response.body.notifications));
    if(user.role==='chief_engineer')assert.ok(response.body.notifications.length>0,'Chief Engineer must receive technician workflow events');
    results.push({phase:'notification API eligibility',role:user.label,status:response.status,count:response.body.notifications?.length??0,passed:true});
  }catch(error){results.push({phase:'notification API eligibility',role:user.label,passed:false,error:String(error)});}
}
writeFileSync(new URL('lifecycle-results.json',out),JSON.stringify(results,null,2));
for(const result of results)console.log(JSON.stringify(result));
assert.ok(results.every(result=>result.passed),'Actual Auth/API/DB lifecycle or notification eligibility failed');
