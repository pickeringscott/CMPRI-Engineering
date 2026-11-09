import test from 'node:test';import assert from 'node:assert/strict';
import {loadTs} from './helpers/load-ts.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hotel=id(1),actor=id(2),job=id(3),part=id(4);
function fixture({authorized=true,enabled=true,rpcError=null}={}){
 const calls=[],filters=[];
 const admin={from(table){const q={select(){return q;},eq(key,value){filters.push({table,key,value});return q;},order(){return q;},range:async()=>({data:[],error:null}),maybeSingle:async()=>({data:{id:job},error:null})};return q;},rpc:async(name,args)=>{calls.push({name,args});return {data:name==='cmpri_read_ticket_parts'?{parts:[],receiptTotals:[]}:part,error:rpcError};}};
 const route=loadTs('src/app/api/work-orders/[id]/parts/route.ts',{
 'next/server':{NextResponse:{json:(body,options={})=>({body,status:options.status||200})}},
 '@/lib/server/auth':{requireCapability:async(_request,cap)=>{assert.equal(cap,'manage_assets');return authorized?{admin,principal:{identity:{id:actor}}}:null;}},
 '@/lib/constants':{HOTEL_ID:hotel},'@/lib/uuid':loadTs('src/lib/uuid.ts'),
 '@/lib/server/paginated-query':loadTs('src/lib/server/paginated-query.ts'),
 },{process:{env:{CMPRI_PO_ENABLED:enabled?'true':'false'}}});
 const body={id:part,name:'LED bulb',item:null,status:'Need to Order',quantity:1,po_line:null,expected_revision:0};
 return {calls,filters,body,post:(b=body)=>route.POST({json:async()=>b},{params:Promise.resolve({id:job})}),get:()=>route.GET({},{params:Promise.resolve({id:job})})};
}
test('parts API retains existing permission and release gates before touching records',async()=>{
 for(const config of [{authorized:false},{enabled:false}]){const f=fixture(config);assert.ok((await f.post()).status>=400);assert.ok((await f.get()).status>=400);assert.equal(f.calls.length,0);assert.equal(f.filters.length,0);}
});
test('server owns actor, property and ticket identity; one RPC commits part, idea and note',async()=>{
 const f=fixture();const result=await f.post({...f.body,actor_id:id(99),hotel_id:id(99),job:id(99)});
 assert.equal(result.status,200);assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.p_actor,actor);assert.equal(f.calls[0].args.p_hotel,hotel);assert.equal(f.calls[0].args.p_job,job);
});
test('forged PO states and invalid quantities cannot reach the mutation',async()=>{
 for(const patch of [{status:'On Order'},{status:'Received'},{quantity:0},{quantity:Infinity},{item:'wrong'},{expected_revision:-1}]){const f=fixture();assert.equal((await f.post({...f.body,...patch})).status,400);assert.equal(f.calls.length,0);}
});
test('context failure returns unavailable rather than an empty parts list',async()=>{
 const f=fixture({rpcError:{code:'42883',message:'Function missing'}});assert.equal((await f.get()).status,503);assert.ok(f.filters.every(filter=>filter.key!=='hotel_id'||filter.value===hotel));
});
