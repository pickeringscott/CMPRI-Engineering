import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers/load-ts.mjs';
import * as search from '../src/lib/work-order-search.ts';
import { sortWorkOrders } from '../src/lib/work-order-sort.ts';
import { readWorkOrderListPreferences, saveWorkOrderListPreferences } from '../src/lib/work-order-list-preferences.ts';
import * as preferences from '../src/lib/work-order-list-preferences.ts';
import { JSDOM } from 'jsdom';
import * as references from '../src/lib/work-order-reference.js';

const rows = [
  {id:'room-124-new',room:'124',status:'Open',created_at:'2026-11-20T10:00:00Z'},
  {id:'room-124-old-b',room:'124',status:'Open',created_at:'2026-11-18T10:00:00Z'},
  {id:'room-124-old-a',room:'Room 124',status:'Open',created_at:'2026-11-18T10:00:00Z'},
  {id:'closed-124',room:'124',status:'Closed',created_at:'2026-11-01T10:00:00Z'},
  {id:'room-1240',room:'1240',status:'Open',created_at:'2026-11-01T10:00:00Z'},
  {id:'ticket-124',room:'100',display_id:'workorder_124',issue:'Issue 124',status:'Open',created_at:'2026-11-01T10:00:00Z'},
].map(row=>({hotel_id:'hotel',...row}));

function fixture(data=rows) {
  const calls=[];
  const admin={rpc:async()=>({data:{all:data.length},error:null}),from(table){
    assert.equal(table,'work_orders');
    const predicates=[],order=[],state={from:0,to:99};
    const query={
      select(){return query;},eq(field,value){predicates.push(row=>row[field]===value);return query;},
      in(field,values){predicates.push(row=>values.includes(row[field]));return query;},lt(field,value){predicates.push(row=>row[field]<value);return query;},
      or(expression){
        calls.push(expression);
        const alternatives=expression.split(/,(?=room\.ilike\.)/).map(item=>{
          const match=item.match(/^room\.ilike\.(".*")$/);assert.ok(match,'only the actual exact-room predicate is accepted by this fixture');
          return JSON.parse(match[1]).toLowerCase();
        });
        predicates.push(row=>alternatives.includes(String(row.room).toLowerCase()));return query;
      },
      order(field,options){order.push([field,options]);return query;},range(from,to){Object.assign(state,{from,to});return query;},
      then(resolve,reject){
        const matching=data.filter(row=>predicates.every(test=>test(row)));
        matching.sort((a,b)=>{
          for(const [field,options] of order){const delta=String(a[field]??'').localeCompare(String(b[field]??''))*(options.ascending?1:-1);if(delta)return delta;}
          return 0;
        });
        return Promise.resolve({data:matching.slice(state.from,state.to+1),count:matching.length,error:null}).then(resolve,reject);
      },
    };return query;
  }};
  const route=loadTs('src/app/api/work-orders/route.ts',{
    '@/lib/server/work-order-parts-status':{attachPartsStatuses:async(_admin,data)=>data},
    '@/lib/work-order-sort':{sortWorkOrders},'@/lib/work-order-search':search,'@/lib/cmpri-location-groups':{},
    '@/lib/work-order-read-policy':{workOrderReadFilter:()=>null},'@/lib/server/work-order-reader':{workOrderReader:()=>({})},
    'next/server':{NextResponse:{json:(body,options={})=>({body,status:options.status??200})}},'@/lib/constants':{HOTEL_ID:'hotel'},
    '@/lib/server/access':{allows:()=>true},'@/lib/server/auth':{requireUser:async()=>({admin,principal:{profile:{role:'Chief Engineer'}}})},
    '@/lib/server/request-auth':{},'@/lib/server/roles':{},'@/lib/server/supabase-admin':{},'@/lib/integrations/spreadsheet-input':{},
    '@/lib/work-order-attribution':{},'@/lib/work-order-duplicates':{},'@/lib/work-order-suggestions':{},'@/lib/equipment-selection':{},'@/lib/work-order-categories':{},
    '@/lib/server/room-availability':{loadCurrentRoomStatuses:async()=>({statuses:new Map(),operations:new Map(),error:null}),currentRoomStatus:()=>null,currentRoomOperation:()=>null},
  });
  return {calls,get:params=>route.GET({nextUrl:{searchParams:new URLSearchParams({filter:'open',sort:'created-oldest',q:'124',...params})}})};
}

test('Room 124 search retains Open, Oldest First and stable ties, excluding closed, room1240, ticket124 and another hotel',async()=>{
  const f=fixture([...rows,{...rows[0],id:'other-property',hotel_id:'other'}]);
  const response=await f.get();
  assert.equal(response.status,200);
  assert.deepEqual(Array.from(response.body.work_orders,row=>row.id),['room-124-old-a','room-124-old-b','room-124-new']);
  assert.equal(response.body.total,3);
  assert(f.calls.every(expression=>!expression.includes('display_id')));
});

test('room search pages the matching status set, preserving oldest-first order past the first hundred',async()=>{
  const many=Array.from({length:203},(_,i)=>({...rows[0],id:`room-${String(i).padStart(3,'0')}`,created_at:new Date(Date.UTC(2026,0,1,0,i)).toISOString()}));
  const response=await fixture([...many,{...many[0],id:'closed',status:'Closed'}]).get({page:'1'});
  assert.equal(response.body.total,203);assert.equal(response.body.work_orders.length,100);
  assert.equal(response.body.work_orders[0].id,'room-100');assert.equal(response.body.work_orders.at(-1).id,'room-199');
});

test('local fallback and draft matching distinguish rooms from explicit ticket references and escape text filters',()=>{
  for(const query of ['124','Room 124','room #124'])assert.deepEqual(rows.filter(row=>search.matchesWorkOrderSearch(row,query)).map(row=>row.id),['room-124-new','room-124-old-b','room-124-old-a','closed-124']);
  assert.equal(search.matchesWorkOrderSearch(rows.at(-1),'WO#124'),true);
  assert.equal(search.matchesWorkOrderSearch(rows[0],'WO#124'),false);
  assert.equal(search.matchesWorkOrderSearch({display_id:'4218',room:'124'},'4218'),true,'four-digit CMPRI ticket numbers remain searchable without a prefix');
  assert.equal(search.matchesWorkOrderSearch({display_id:'4218',room:'124'},'Room 4218'),false);
  assert.equal(search.matchesWorkOrderSearch({room:'4218'},'Room 4218'),true,'explicit Room requests remain exact at any supported length');
  assert.equal(search.workOrderSearchExpression('4218'),'display_id.ilike."%4218%"');
  assert.match(search.workOrderSearchExpression('Room 4218'),/^room\.ilike\."4218"/);
  assert.equal(search.matchesWorkOrderSearch({room:'124',is_draft:true},'124'),true);
  const expression=search.workOrderSearchExpression('50%,_room\\door');
  assert.match(expression,/50\\\\%,\\\\_room\\\\\\\\door/);
  assert.doesNotMatch(search.workOrderSearchExpression('progress'),/status\.ilike/);
  assert.match(search.workOrderSearchExpression('progress'),/status\.in\.\("In Progress"\)/);
});

test('list preferences survive reopening within their property/account and retain only bounded navigation values',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const selection={filter:'open',sort:'created-oldest',query:'124',page:2};
  saveWorkOrderListPreferences(storage,'hotel:user', {...selection,orders:rows,access_token:'never-store'});
  assert.deepEqual(readWorkOrderListPreferences(storage,'hotel:user'),selection);
  assert.deepEqual(readWorkOrderListPreferences(storage,'another:user'),{filter:'all',sort:'default',query:'',page:0});
  assert.deepEqual(readWorkOrderListPreferences(storage,'hotel:another'),{filter:'all',sort:'default',query:'',page:0});
  const serialized=[...values.values()][0];assert.doesNotMatch(serialized,/orders|access_token|never-store|created_at/);
  const count=values.size;saveWorkOrderListPreferences(storage,undefined,selection);assert.equal(values.size,count);
  const key=[...values.keys()][0];values.set(key,JSON.stringify({filter:'invalid',sort:'bad',query:'x'.repeat(300),page:-1}));
  const restored=readWorkOrderListPreferences(storage,'hotel:user');assert.equal(restored.filter,'all');assert.equal(restored.sort,'default');assert.equal(restored.page,0);assert.equal(restored.query.length,200);
  values.set(key,'{broken');assert.equal(readWorkOrderListPreferences(storage,'hotel:user').query,'');
});

test('reopening an expired saved page keeps Room124/Open/Oldest First and returns to the remaining page',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'https://cmpri.test/engineering',pretendToBeVisual:true});
  const previous=Object.fromEntries(['window','document','navigator','IS_REACT_ACT_ENVIRONMENT'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
  const React=await import('react'),{createRoot}=await import('react-dom/client'),jsx=await import('react/jsx-runtime');
  const requested=[];
  const Component=loadTs('src/components/desktop/WorkOrderListWindow.tsx',{
    react:React,'react/jsx-runtime':jsx,
    '@/lib/work-order-reference.js':references,'@/lib/work-order-search':search,'@/lib/work-order-list-preferences':preferences,'@/lib/work-order-sort':{sortWorkOrders},
    '@/components/PartsStatusPill':{default:()=>null},'@/components/WorkOrderImportPill':{default:()=>null},'@/components/GuestGroupBadge':{default:()=>null},'@/components/LoyaltyBadge':{default:()=>null},
    '@/components/WorkOrderFilters':{default:({filter})=>React.createElement('div',{'data-active-filter':filter})},
    '@/lib/auth/client-session':{authorizationHeaders:async()=>({})},
    '@/lib/events/browser':{subscribeResources:(_topics,load)=>{void load();return ()=>{};}},
    '@/lib/dashboard/kpi-filters':{normalizeKpiStatus:status=>status,filterKpiWorkOrders:(data,filter)=>filter==='all'?data:data.filter(row=>row.status==='Open')},
    '@/lib/room-availability':{roomStatusBadge:()=>null},'@/lib/room-operations-reports':{normalizePrintedTime:()=>null},'@/lib/constants':{HOTEL_TIME_ZONE:'America/Chicago'},
  },{window:dom.window,URLSearchParams,AbortController,setTimeout,clearTimeout,fetch:async url=>{
    const query=new URL(url,dom.window.location.origin).searchParams;requested.push(Object.fromEntries(query));
    return {ok:true,json:async()=>({work_orders:query.get('page')==='0'?rows.slice(0,3):[],total:3,counts:{open:3}})};
  }}).default;
  saveWorkOrderListPreferences(dom.window.localStorage,'hotel:user',{filter:'open',sort:'created-oldest',query:'124',page:2});
  const root=createRoot(dom.window.document.getElementById('root'));
  try{
    await React.act(async()=>root.render(React.createElement(Component,{orders:[],loading:false,preferencesScope:'hotel:user',onOpenWorkOrder(){}})));
    for(let i=0;i<3;i++)await React.act(async()=>await new Promise(resolve=>setTimeout(resolve,350)));
    assert.deepEqual(requested.map(query=>query.page),['2','0']);
    assert(requested.every(query=>query.filter==='open'&&query.sort==='created-oldest'&&query.q==='124'),'no transient All request or erased search while restoring');
    assert.equal(dom.window.document.querySelector('[data-active-filter]').dataset.activeFilter,'open');
    assert.equal(dom.window.document.querySelector('input[type=search]').value,'124');
    assert.equal(dom.window.document.querySelectorAll('[data-preview-status]').length,3);
    assert.equal(readWorkOrderListPreferences(dom.window.localStorage,'hotel:user').page,0);
    assert.equal(dom.window.document.querySelector('[aria-label="Work order pages"]'),null,'the recovered page is visible even when the pager is no longer needed');
  }finally{
    await React.act(async()=>root.unmount());dom.window.close();
    for(const [key,descriptor] of Object.entries(previous)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  }
});
