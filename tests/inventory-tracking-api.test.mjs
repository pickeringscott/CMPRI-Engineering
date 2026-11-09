import test from 'node:test';import assert from 'node:assert/strict';import {loadTs} from './helpers/load-ts.mjs';
import {inventoryRequest,matchingInventory,validStockCount,inventoryUnitOptions,mergeInventorySnapshot} from '../src/lib/inventory.ts';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const request={kind:'inventory',request_id:id(1),item_name:'Chemical',item_type:'Chemical',unit_of_measure:'LB',quantity_on_hand:25,storage_location_id:id(3),reason:'Physical count'};
function fixture({authorized=true,error=null,data={inventory:[],assets:[]}}={}){
 const calls=[],principal={identity:{id:id(2)},profile:{full_name:'Scott'}};
 const admin={rpc:async(name,args)=>{calls.push({name,args});return {data,error}},from:()=>{throw Error('Unexpected extra database query');}};
 const route=loadTs('src/app/api/engineering/catalog/route.ts',{
  'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status||200})}},'@/lib/constants':{HOTEL_ID:id(9)},'@/lib/server/auth':{requireCapability:async()=>authorized?{admin,principal}:null},'@/lib/inventory':{inventoryRequest},
 });
 return {calls,get:()=>route.GET({nextUrl:new URL('https://local/api/engineering/catalog?stock=1')}),post:body=>route.POST({json:async()=>body}),patch:body=>route.PATCH({json:async()=>body})};
}
test('catalog snapshot uses exactly one bundled RPC and no follow-up table queries',async()=>{
 const f=fixture({data:{inventory:Array.from({length:1001},(_,i)=>({id:id(i+100)})),assets:[]}});const result=await f.get();assert.equal(result.status,200);assert.equal(result.body.inventory.length,1001);assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'cmpri_inventory_snapshot');assert.equal(f.calls[0].args.p_stock_only,true);
});
test('inventory write validates inputs and commits through one RPC with server actor/property',async()=>{
 const f=fixture({data:{inventory_item:{id:id(1)}}});assert.equal((await f.post({...request,actor:id(88),hotel_id:id(88)})).status,200);assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.p_actor,id(2));assert.equal(f.calls[0].args.p_hotel,id(9));assert.equal(f.calls[0].args.p_id,request.request_id);
 for(const body of [{...request,request_id:null},{...request,unit_of_measure:'???'},{...request,storage_location_id:''},{...request,item_type:'Unknown'},{...request,unit_of_measure:'EA',quantity_on_hand:.5}]){const bad=fixture();assert.equal((await bad.post(body)).status,400);assert.equal(bad.calls.length,0);}
});
test('old absolute-count updates are refused; valid adjustments require expected revision and reason',async()=>{
 for(const body of [{kind:'inventory',id:id(1),quantity_on_hand:99},{...request,id:id(1),action:'adjust',quantity:99,expected_revision:null}]){const f=fixture();assert.equal((await f.patch(body)).status,400);assert.equal(f.calls.length,0);}
 const f=fixture({error:{code:'40001',message:'Inventory changed'}});const result=await f.patch({...request,id:id(5),action:'adjust',quantity:20,expected_revision:2});assert.equal(result.status,409);assert.equal(result.body.refresh_required,true);
});
test('unavailable data is not presented as an empty inventory; access gates precede reads',async()=>{
 const unavailable=fixture({error:{code:'XX000',message:'Unavailable'},data:null});assert.equal((await unavailable.get()).status,503);
 const denied=fixture({authorized:false});assert.equal((await denied.get()).status,403);assert.equal((await denied.post(request)).status,403);assert.equal(denied.calls.length,0);
});
test('inventory units, exact identities and newer local revisions remain deterministic',()=>{
 assert.equal(validStockCount(.5,'EA'),false);assert.equal(validStockCount(.5,'LB'),true);assert.deepEqual(inventoryUnitOptions('GAL'),['GAL','L','ML','FLOZ']);
 const current={id:id(1),item_name:'Fitting ½ in',manufacturer:'ACME',vendor_sku:'A',unit_of_measure:'EA',inventory_revision:3,quantity_on_hand:9};
 assert.equal(matchingInventory([current],{...current,id:undefined,item_name:'Fitting 1⁄2 in'}).id,current.id);
 assert.equal(mergeInventorySnapshot([current],[{...current,inventory_revision:2,quantity_on_hand:10}])[0].quantity_on_hand,9);
});
