import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { loadTs } from './helpers/load-ts.mjs';

// Private acceptance input is an authorized Supabase export, kept outside git.
// No network calls: the actual route and existing RPC run over those records locally.
test('actual PM records: route confirmation, reuse, stale sources and missing RPC preserve inspection history', {
  skip: !process.env.CMPRI_PM_ACCEPTANCE_PATH,
}, async () => {
  const data = JSON.parse(readFileSync(process.env.CMPRI_PM_ACCEPTANCE_PATH, 'utf8'));
  const { account, session } = data;
  assert.equal(account.profile.id, session.user.id);
  assert.equal(account.profile.active, true);
  const hotel = session.hotelId;
  const db = new PGlite();
  try {
    await db.exec(`create role service_role; create role authenticated; create role anon;
      create table cmpri_pm_proposals(id uuid primary key,hotel_id uuid,template_id text,period_start date,scope_key text,payload jsonb,revision int,status text,submitted_by uuid);
      create table cmpri_room_pm_history(hotel_id uuid,room text,period_start date,completed_on date,item_answers jsonb,primary key(hotel_id,room,period_start));
      create table locations(id uuid primary key,hotel_id uuid,name text,area text,room_number text,location_type text,active boolean);
      create table cmpri_winter_items(hotel_id uuid,year int,item_id text,checked boolean,revision int,changed_by uuid,changed_by_name text,changed_at timestamptz);
      create table work_orders(id uuid primary key default gen_random_uuid(),hotel_id uuid,display_id text,location_id uuid,room text,asset_id uuid,asset_name text,category text,issue text,priority text,notes text,
        created_by uuid,creator_account_user_id uuid,creator_name text,submitted_by_name text,creator_source text,status text,submitted_by_user_id uuid,technician_name text,action_root_cause text,parts text,cost numeric,hours numeric,import_source text,import_external_id text);
      create unique index pm_identity on work_orders(hotel_id,import_source,import_external_id);
      grant usage on schema public to service_role;
      grant select,insert,update on all tables in schema public to service_role;`);
    for (const [table, rows] of [['cmpri_pm_proposals', data.proposals], ['cmpri_room_pm_history', data.rooms], ['locations', data.locations], ['work_orders', data.links]]) {
      await db.query(`insert into ${table} select * from jsonb_populate_recordset(null::${table},$1::jsonb)`, [JSON.stringify(rows.map(row => ({ ...row, hotel_id: hotel })))]);
    }
    await db.exec(readFileSync('supabase/migrations/20261101214605_cmpri_atomic_pm_confirmation.sql', 'utf8'));
    await db.exec('set role service_role');
    const sourceSnapshot = async () => (await db.query(`select jsonb_build_object(
      'proposals',(select jsonb_agg(to_jsonb(p) order by id) from cmpri_pm_proposals p),
      'rooms',(select jsonb_agg(to_jsonb(r) order by room,period_start) from cmpri_room_pm_history r)) as value`)).rows[0].value;
    const before = await sourceSnapshot();
    let rpcCalls = 0, directInserts = 0, missingRpc = false, race = null, lastRpcError = '';
    const admin = { from(table) {
      assert(['cmpri_pm_proposals','cmpri_room_pm_history','work_orders','locations','cmpri_winter_items'].includes(table));
      const filters = [], orders = []; let range, projection;
      async function materialize() {
        // Match PostgREST's date wire format rather than PGlite's Date objects.
        let rows = (await db.query(`select * from ${table}`)).rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?value.toISOString().slice(0,10):value])));
        for (const [kind, key, value] of filters) rows = rows.filter(row => kind === 'eq' ? row[key] === value : kind === 'neq' ? row[key] !== value : kind === 'gte' ? row[key] >= value : kind === 'lte' ? row[key] <= value : value.includes(row[key]));
        rows.sort((a,b) => { for (const key of orders) { const n=String(a[key]).localeCompare(String(b[key])); if(n)return n; } return 0; });
        if (range) rows=rows.slice(range[0],range[1]+1);
        if (projection && projection!=='*') rows=rows.map(row=>Object.fromEntries(projection.split(',').map(key=>[key,row[key]])));
        return { data: rows, error: null };
      }
      const q = { select(fields){projection=fields?.replaceAll(' ','');return q;},eq(k,v){filters.push(['eq',k,v]);return q;},neq(k,v){filters.push(['neq',k,v]);return q;},gte(k,v){filters.push(['gte',k,v]);return q;},lte(k,v){filters.push(['lte',k,v]);return q;},in(k,v){filters.push(['in',k,v]);return q;},order(k){orders.push(k);return q;},range(a,b){range=[a,b];return q;},limit(n){range=[0,n-1];return q;},
        async maybeSingle(){const r=await materialize();assert(r.data.length<=1);return {...r,data:r.data[0]||null};},then(resolve,reject){return materialize().then(resolve,reject);},insert(){directInserts++;throw Error('PM confirmation must not fall back to a direct insert');}};
      return q;
    }, async rpc(name, args) {
      assert.equal(name,'cmpri_confirm_pm_work_order');rpcCalls++;
      if(missingRpc)return {data:null,error:{code:'PGRST202',message:'RPC unavailable'}};
      if(race){const action=race;race=null;await action(args.p_guard);}
      try { return {data:(await db.query('select cmpri_confirm_pm_work_order($1::uuid,$2::jsonb,$3::jsonb) value',[args.p_hotel,JSON.stringify(args.p_guard),JSON.stringify(args.p_order)])).rows[0].value,error:null}; }
      catch(error){lastRpcError=error.message;return {data:null,error:{code:error.code,message:error.message}};}
    }};
    const principal={identity:{id:session.user.id,email:session.user.email},profile:account.profile,membership:account.membership,permissions:account.permissions,hotelId:hotel};
    const auth={principal,user:{id:session.user.id,email:session.user.email},profile:account.profile,membership:account.membership,admin};
    const deps={'server-only':{},'@/lib/constants':{HOTEL_ID:hotel},'next/server':{NextResponse:{json:(value,init)=>Response.json(value,init)}},
      '@/lib/server/auth':{requireUser:async()=>({principal,admin}),requireUserAttempt:async()=>({ok:true,principal,admin,mcp:false})},'@/lib/server/request-auth':{authenticatedUser:async()=>auth},'@/lib/server/supabase-admin':{createSupabaseAdmin:()=>admin}};
    const load=path=>loadTs(path,deps,{Error,Response,setTimeout});
    const current=loadTs('src/lib/pm/catalog.ts',{'./source-catalog.json':{default:JSON.parse(readFileSync('src/lib/pm/source-catalog.json','utf8'))}},{Error});
    deps['@/lib/pm/catalog']=current;
    deps['@/lib/pm/recorded-catalog']=loadTs('src/lib/pm/recorded-catalog.ts',{'./catalog':current,'./recorded-definitions.json':{default:JSON.parse(readFileSync('src/lib/pm/recorded-definitions.json','utf8'))}},{Error});
    for(const [alias,path] of Object.entries({
      '@/lib/pm/issues':'src/lib/pm/issues.ts','@/lib/pm/recorded-issues':'src/lib/pm/recorded-issues.ts',
      '@/lib/uuid':'src/lib/uuid.ts','@/lib/server/access':'src/lib/server/access.ts','@/lib/server/roles':'src/lib/server/roles.ts',
      '@/lib/cmpri-location-groups':'src/lib/cmpri-location-groups.ts','@/lib/work-order-read-policy':'src/lib/work-order-read-policy.ts',
      '@/lib/server/work-order-reader':'src/lib/server/work-order-reader.ts','@/lib/work-order-sort':'src/lib/work-order-sort.ts',
      '@/lib/integrations/spreadsheet-input':'src/lib/integrations/spreadsheet-input.ts','@/lib/work-order-attribution':'src/lib/work-order-attribution.ts',
      '@/lib/work-order-duplicates':'src/lib/work-order-duplicates.ts','@/lib/work-order-suggestions':'src/lib/work-order-suggestions.ts',
      '@/lib/equipment-selection':'src/lib/equipment-selection.ts','@/lib/work-order-categories':'src/lib/work-order-categories.ts',
      '@/lib/pm/linked-form-review':'src/lib/pm/linked-form-review.ts','@/lib/pm/work-order-form-target':'src/lib/pm/work-order-form-target.ts',
      '@/lib/server/paginated-query':'src/lib/server/paginated-query.ts',
      '@/lib/winter-preparedness':'src/lib/winter-preparedness.ts',
    }))deps[alias]=load(path);
    deps['@/lib/server/room-availability']={}; // POST never reads occupancy or calls another service.
    deps['@/lib/server/pm-work-order']=load('src/lib/server/pm-work-order.ts');
    const reader=load('src/lib/server/pm-recorded-issues.ts');
    const state=await reader.loadRecordedIssueState(admin,session.user.id);
    deps['@/lib/server/pm-recorded-issues']=reader;
    deps['@/lib/server/winter-preparedness-store']=load('src/lib/server/winter-preparedness-store.ts');
    const winterStore=deps['@/lib/server/winter-preparedness-store'];
    assert.equal(winterStore.winterHotel(principal),hotel);
    assert.throws(()=>winterStore.winterHotel(principal,true),error=>error.status===403);
    assert.throws(()=>winterStore.winterHotel({...principal,profile:{...principal.profile,active:false}}),error=>error.status===403);
    assert.throws(()=>winterStore.winterHotel({...principal,membership:{...principal.membership,active:false}}),error=>error.status===403);
    assert(Array.isArray(data.winter?.items),'Include the actual winter-table export in private acceptance');
    for(const row of data.winter.items)await db.query('insert into cmpri_winter_items select * from jsonb_populate_record(null::cmpri_winter_items,$1::jsonb)',[JSON.stringify(row)]);
    const winterRoute=loadTs('src/app/api/winter-preparedness/route.ts',deps,{Error,Response,process:{env:{CMPRI_MANUAL_PREVIEW_READ_ONLY:'1'}}});
    const winterResponse=await winterRoute.GET({});assert.equal(winterResponse.status,200);
    const winter=await winterResponse.json();assert.deepEqual(winter.items,data.winter.items);assert.equal(winter.preview_read_only,true);
    assert.equal((await winterRoute.PATCH({text:()=>{throw Error('Preview must reject before reading a mutation');}})).status,403);
    const savedIssuesRoute=load('src/app/api/preventive-maintenance/recorded-issues/route.ts');
    const savedIssuesResponse=await savedIssuesRoute.GET({});
    assert.equal(savedIssuesResponse.status,200);
    const savedIssues=await savedIssuesResponse.json();
    assert.equal(savedIssues.records.length,state.sources.length);
    assert.equal(savedIssues.links.length,data.links.length);
    assert.equal(savedIssues.canConfirm,true,'The real System Admin retains ticket controls');
    if(process.env.CMPRI_PM_BROWSER_REPLAY_OUT){
      const pmRoute=load('src/app/api/preventive-maintenance/route.ts');
      const response=await pmRoute.GET({nextUrl:{searchParams:new URLSearchParams({week:current.pmWeekStart(new Date().toISOString().slice(0,10))})}});
      assert.equal(response.status,200);
      writeFileSync(process.env.CMPRI_PM_BROWSER_REPLAY_OUT,JSON.stringify({pm:await response.json(),issues:{...savedIssues,preview_read_only:true},winter}),{mode:0o600});
    }
    const externalId=(s,i)=>deps['@/lib/pm/issues'].pmIssueExternalId(s.templateId,s.period,s.scope,i.key);
    const linkedKeys=new Set(data.links.map(row=>row.import_external_id));
    const candidates=state.sources.flatMap(source=>source.hold?[]:source.issues.filter(issue=>!linkedKeys.has(externalId(source,issue))).map(issue=>({source,issue})));
    const input=({source,issue})=>{
      const room=source.scope.match(/^room:(\d{2,4})$/)?.[1];
      const location=data.locations.find(row=>room?String(row.room_number||'').trim()===room||row.name.match(/\b\d{2,4}\b/)?.[0]===room:row.id===issue.locationId)||(!room?data.locations[0]:null);
      assert(location,'No actual location matches the recorded room');
      return {confirmed:true,recordedSource:{kind:source.kind,id:source.id},fingerprint:source.fingerprint,issueKey:issue.key,detail:issue.detail||issue.label,locationId:location.id};
    };
    assert(candidates.length>=2);
    const route=load('src/app/api/work-orders/route.ts');
    const submit=async submission=>{
      const response=await route.POST({json:async()=>({orders:[{}],pm_submission:submission})});
      return {status:response.status,...await response.json()};
    };
    const submission=input(candidates[0]);
    const first=await submit(submission);assert.equal(first.status,200,[first.error,lastRpcError].filter(Boolean).join(': '));assert(first.work_orders[0].id);
    const repeat=await submit(submission);assert.equal(repeat.status,200,repeat.error);assert.equal(repeat.work_orders[0].id,first.work_orders[0].id);assert.equal(repeat.reused,true);
    assert.equal(rpcCalls,1);assert.equal(directInserts,0);assert.deepEqual(await sourceSnapshot(),before);
    assert.equal((await submit({...submission,confirmed:false})).status,400);
    assert.equal((await submit({...submission,fingerprint:'stale'})).status,409);
    const second=input(candidates[1]);
    missingRpc=true;assert.equal((await submit(second)).status,409);missingRpc=false;
    let restore;
    race=async guard=>{
      if(guard.proposals.length){const row=guard.proposals[0];restore=()=>db.query('update cmpri_pm_proposals set payload=$1::jsonb where id=$2',[JSON.stringify(row.payload),row.id]);await db.query("update cmpri_pm_proposals set payload=jsonb_set(payload,'{notes}',to_jsonb(coalesce(payload->>'notes','')||' ')) where id=$1",[row.id]);}
      else {const row=guard.rooms[0];restore=()=>db.query('update cmpri_room_pm_history set completed_on=$1 where room=$2 and period_start=$3',[row.completed_on,row.room,row.period_start]);await db.query('update cmpri_room_pm_history set completed_on=case when completed_on is null then period_start else null end where room=$1 and period_start=$2',[row.room,row.period_start]);}
    };
    assert.equal((await submit(second)).status,409);await restore();
    assert.equal(directInserts,0);assert.deepEqual(await sourceSnapshot(),before);
    assert.equal((await db.query('select count(*)::int n from work_orders')).rows[0].n,data.links.length+1);
    await db.exec('reset role;set role authenticated');
    await assert.rejects(db.query('select cmpri_confirm_pm_work_order($1::uuid,$2::jsonb,$3::jsonb)',[hotel,'{}','{}']),/permission denied/);
    console.log(JSON.stringify({actualProposals:data.proposals.length,actualRoomHistory:data.rooms.length,existingPmOrders:data.links.length,recordedIssueSources:state.sources.length,createdOnlyInMemory:1,sourceUnchanged:true,liveWrites:0,externalRequests:0}));
  } finally { await db.close(); }
});
