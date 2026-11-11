import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';

const hotel = '00000000-0000-0000-0000-000000000001';
const otherHotel = '00000000-0000-0000-0000-000000000002';
const today = '2026-11-11';
const rows = [
  ['a', 'Open', 'High', '2026-11-10', '409', 'test-user'],
  ['b', 'In Progress', 'Urgent', today, '409', 'test-user'],
  ['c', 'Done', 'Normal', null, '409', 'test-user'],
  ['d', 'Pending Verification', 'High', '2026-11-10', '409', 'test-user'],
  ['e', 'Completed', 'High', '2026-11-01', '409', 'test-user'],
  ['f', 'Closed', 'High', null, '409', 'test-user'],
  ['g', 'Will Not Do', 'Normal', null, '409', 'test-user'],
  ['h', 'Open', 'Low', '2026-11-12', '410', 'test-user'],
  ['i', 'Open', 'High', '2026-11-10', '409', 'hidden-user'],
  ['k', 'Completed', 'Normal', null, '410', 'test-user'],
];
const expected = {
  authenticated: { all:9, pending:1, open:4, progress:1, priority:2, overdue:1, completed:2, closed:2 },
  service_role: { all:10, pending:1, open:5, progress:1, priority:3, overdue:2, completed:2, closed:2 },
};
const compiled = ts.transpileModule(readFileSync(new URL(process.env.ROUTE_SOURCE || '../src/app/api/work-orders/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function fixture({ role = 'authenticated', readerFilter = null, authorized = true, signedIn = true,
  rpcError = null, countError = false, listError = false, empty = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role authenticated; create role service_role;
    create table work_orders (
      id text primary key, hotel_id uuid not null, display_id text, revision integer default 1,
      updated_at timestamptz default now(), room text, asset_name text, category text,
      issue text, priority text, technician_name text, status text, due_by date,
      created_at timestamptz default now(), import_source text, import_external_id text,
      notes text, visible_to text
    );
    alter table work_orders enable row level security;
    grant select on work_orders to authenticated, service_role;
    create policy user_rows on work_orders for select to authenticated using (visible_to = 'test-user');
    create policy server_rows on work_orders for select to service_role using (true);
    create function cmpri_work_order_dashboard_counts(p_hotel uuid, p_today date) returns jsonb
    language sql stable set search_path = '' as $$
      select jsonb_build_object(
        'all',count(*),
        'pending',count(*) filter(where status='Pending Verification'),
        'open',count(*) filter(where status in ('Open','In Progress','Done')),
        'progress',count(*) filter(where status='In Progress'),
        'priority',count(*) filter(where status in ('Open','In Progress','Done') and priority in ('Urgent','High')),
        'overdue',count(*) filter(where status in ('Open','In Progress','Done') and due_by < p_today),
        'completed',count(*) filter(where status='Completed'),
        'closed',count(*) filter(where status in ('Closed','Will Not Do'))
      ) from public.work_orders where hotel_id=p_hotel;
    $$;
    revoke all on function cmpri_work_order_dashboard_counts(uuid,date) from public, authenticated;
    grant execute on function cmpri_work_order_dashboard_counts(uuid,date) to service_role;
  `);
  if (!empty) {
    for (const [id,status,priority,due,room,visible] of rows) {
      await db.query('insert into work_orders(id,hotel_id,display_id,status,priority,due_by,room,visible_to,issue) values ($1,$2,$1,$3,$4,$5,$6,$7,$8)',
        [id,hotel,status,priority,due,room,visible,id === 'a' ? 'needle leak' : 'unrelated issue']);
    }
    await db.query("insert into work_orders(id,hotel_id,status,priority,room,visible_to) values ('cross-hotel',$1,'Open','High','409','test-user')",[otherHotel]);
  }
  await db.exec(`set role ${role}`);
  const calls = [], rpcs = [];
  const admin = {
    async rpc(name, params) {
      rpcs.push({name,params});
      assert.equal(name, 'cmpri_work_order_dashboard_counts');
      assert.equal(params.p_hotel, hotel);
      if (rpcError) return {data:null,error:rpcError};
      try { return {data:(await db.query('select cmpri_work_order_dashboard_counts($1::uuid,$2::date) as value',[params.p_hotel,params.p_today])).rows[0].value,error:null}; }
      catch (error) { return {data:null,error}; }
    },
    from(table) {
      assert.equal(table,'work_orders');
      const state = {head:false,where:[],values:[],order:[],from:0,to:99,filters:[]};
      calls.push(state);
      function clause(sql, values = []) {
        let offset = 0;
        state.where.push(sql.replace(/\?/g, () => `$${state.values.length + ++offset}`));
        state.values.push(...values);
      }
      const query = {
        select(columns, options) { state.columns=columns;state.head=!!options?.head;return query; },
        eq(field,value) { state.filters.push(['eq',field,value]);clause(`${field} = ?`,[value]);return query; },
        lt(field,value) { state.filters.push(['lt',field,value]);clause(`${field} < ?`,[value]);return query; },
        in(field,values) { state.filters.push(['in',field,Array.from(values)]);clause(`${field} in (${values.map(()=>'?').join(',')})`,Array.from(values));return query; },
        or(expression) {
          state.filters.push(['or',expression]);
          if (expression === 'room.eq.409') clause('room = ?',['409']);
          else if (expression.includes('issue.ilike."%needle%"')) clause('issue ilike ?',['%needle%']);
          else throw new Error(`Unmocked OR expression: ${expression}`);
          return query;
        },
        order(field,{ascending=true}={}) {state.order.push(`${field} ${ascending?'asc':'desc'}`);return query;},
        range(from,to) {state.from=from;state.to=to;return query;},
        then(resolve,reject) {
          return (async()=>{
            if ((state.head && countError) || (!state.head && listError)) return {data:null,count:null,error:{code:'XX000',message:'fixture query failure'}};
            try {
              const where=state.where.length?' where '+state.where.join(' and '):'';
              const count=Number((await db.query('select count(*) as value from work_orders'+where,state.values)).rows[0].value);
              const order=state.order.length?' order by '+state.order.join(','):'';
              const data=state.head?null:(await db.query(`select ${state.columns} from work_orders${where}${order} limit ${state.to-state.from+1} offset ${state.from}`,state.values)).rows;
              return {data,count,error:null};
            } catch(error) {return {data:null,count:null,error};}
          })().then(resolve,reject);
        },
      };
      return query;
    },
  };
  const principal={identity:{id:'test-user'},hotelId:hotel,profile:{role:'chief_engineer'}};
  const dependencies={
    '@/lib/server/work-order-parts-status':{attachPartsStatuses:async(_client,orders)=>orders},
    '@/lib/work-order-sort':{sortWorkOrders:orders=>orders},
    '@/lib/cmpri-location-groups':{frontDeskCommonArea:()=>null},
    '@/lib/work-order-read-policy':{workOrderReadFilter:()=>readerFilter},
    '@/lib/server/work-order-reader':{workOrderReader:value=>value},
    'next/server':{NextResponse:{json:(body,options={})=>({body,status:options.status??200})}},
    '@/lib/constants':{HOTEL_ID:hotel},
    '@/lib/server/access':{allows:()=>authorized},
    '@/lib/server/auth':{requireUser:async()=>signedIn?{principal,admin}:null},
    '@/lib/server/request-auth':{authenticatedUser:async()=>null},
    '@/lib/server/roles':{roleAllows:()=>false},
    '@/lib/server/supabase-admin':{createSupabaseAdmin:()=>{throw new Error('Must not elevate the request client');}},
    '@/lib/integrations/spreadsheet-input':{},
    '@/lib/work-order-attribution':{},
    '@/lib/work-order-duplicates':{},
    '@/lib/work-order-suggestions':{},
    '@/lib/equipment-selection':{},
    '@/lib/work-order-categories':{},
    '@/lib/server/room-availability':{
      loadCurrentRoomStatuses:async()=>({statuses:new Map(),operations:new Map(),error:null}),
      currentRoomStatus:()=>null,currentRoomOperation:()=>null,
    },
  };
  const exports={};
  vm.runInNewContext(compiled,{exports,Intl:{DateTimeFormat:class{format(){return today;}}},Date,
    require(name){assert.ok(name in dependencies,`Unmocked import: ${name}`);return dependencies[name];},
  });
  return {db,calls,rpcs,async get(params={}){return exports.GET({nextUrl:{searchParams:new URLSearchParams(params)}});},close:()=>db.close()};
}

for (const role of ['authenticated','service_role']) test(`${role}: counts preserve all statuses, hotel scope and RLS`,async()=>{
  const f=await fixture({role});
  try {
    const result=await f.get();assert.equal(result.status,200,JSON.stringify(result.body));
    assert.deepEqual(JSON.parse(JSON.stringify(result.body.counts)),expected[role]);
    assert.equal(result.body.total,expected[role].all);
    assert.ok(!result.body.work_orders.some(row=>row.id==='cross-hotel'));
    assert.equal(result.body.work_orders.some(row=>row.id==='i'),role==='service_role');
    assert.equal(f.rpcs.length,1);
    assert.equal(f.calls.filter(call=>call.head).length,role==='authenticated'?8:0);
    for(const call of f.calls)assert.ok(call.filters.some(([op,field,value])=>op==='eq'&&field==='hotel_id'&&value===hotel));
    const grants=await f.db.query("select has_function_privilege('authenticated','cmpri_work_order_dashboard_counts(uuid,date)','EXECUTE') as allowed");
    assert.equal(grants.rows[0].allowed,false,'fallback must not grant access to the aggregate');
  }finally{await f.close();}
});

for (const role of ['authenticated','service_role']) test(`${role}: narrower reader filter never uses hotel-wide aggregate`,async()=>{
  const f=await fixture({role,readerFilter:'room.eq.409'});
  try{
    const result=await f.get();assert.equal(result.status,200);
    assert.equal(result.body.total,role==='authenticated'?7:8);
    assert.equal(result.body.counts.all,result.body.total);
    assert.ok(result.body.work_orders.every(row=>row.room==='409'));
    assert.equal(f.rpcs.length,0);
    assert.equal(f.calls.filter(call=>call.head).length,8);
    for(const call of f.calls)assert.ok(call.filters.some(([op,value])=>op==='or'&&value==='room.eq.409'));
  }finally{await f.close();}
});

test('authenticated fallback preserves selected filter, global badges, search and pagination',async()=>{
  const f=await fixture();
  try{
    for(const [filter,count] of Object.entries(expected.authenticated)){
      const result=await f.get({filter});assert.equal(result.status,200,filter);
      assert.equal(result.body.total,count,filter);assert.equal(result.body.work_orders.length,count,filter);
      assert.deepEqual(JSON.parse(JSON.stringify(result.body.counts)),expected.authenticated,filter);
    }
    const searched=await f.get({filter:'closed',q:'needle'});
    assert.equal(searched.status,200);assert.equal(searched.body.total,1);assert.equal(searched.body.work_orders[0].id,'a');
    assert.equal(searched.body.counts.all,9,'search does not change global status badges');
    const page=await f.get({page:'1'});assert.equal(page.status,200);assert.equal(page.body.total,9);assert.equal(page.body.work_orders.length,0);assert.equal(page.body.counts.all,9);
  }finally{await f.close();}
});

test('empty authorized data produces zero counts',async()=>{
  const f=await fixture({empty:true});try{const result=await f.get();assert.equal(result.status,200);assert.equal(result.body.total,0);assert.ok(Object.values(result.body.counts).every(value=>value===0));}finally{await f.close();}
});

for(const error of [{code:'XX000'},{code:'PGRST202'},{code:'57014'}])test(`non-permission RPC failure ${error.code} remains visible`,async()=>{
  const f=await fixture({rpcError:error});try{const result=await f.get();assert.equal(result.status,503);assert.equal(f.calls.filter(call=>call.head).length,0);}finally{await f.close();}
});
test('failed fallback count returns 503 rather than partial counts',async()=>{
  const f=await fixture({countError:true});try{const result=await f.get();assert.equal(result.status,503);assert.equal(result.body.counts,undefined);}finally{await f.close();}
});
test('failed row query does not attempt fallback counts',async()=>{
  const f=await fixture({listError:true});try{const result=await f.get();assert.equal(result.status,503);assert.equal(f.calls.filter(call=>call.head).length,0);}finally{await f.close();}
});
for(const [options,status] of [[{signedIn:false},401],[{authorized:false},403]])test(`authorization guard ${status} remains unchanged`,async()=>{
  const f=await fixture(options);try{const result=await f.get();assert.equal(result.status,status);assert.equal(f.calls.length,0);assert.equal(f.rpcs.length,0);}finally{await f.close();}
});
