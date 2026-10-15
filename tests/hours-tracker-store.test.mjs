import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import * as core from '../src/lib/hours-tracker.ts';
function load(path, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, structuredClone, require: name => { if (!(name in dependencies)) throw new Error(name); return dependencies[name]; } });
  return exports;
}
const roles = load('../src/lib/server/roles.ts');
const store = load('../src/lib/server/hours-tracker-store.ts', { './roles': roles, '../hours-tracker': core });
const owner = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const principal = (id=owner, role='Chief Engineer') => ({ identity:{id}, profile:{id,role,active:true}, membership:{user_id:id,hotel_id:'hotel',active:true},hotelId:'hotel' });
const period = start => ({start,days:core.emptyPeriod(start),rateCents:2229,deductionPercent:22});
test('four approved roles, active matching identity and no MCP', () => {
  for(const role of ['Chief Engineer','Assistant General Manager','Front Desk Manager','Maintenance Technician','assistant_manager','front_desk_manager','technician']) assert.equal(store.hoursOwner(principal(owner,role)),owner);
  assert.equal(store.hoursOwner({...principal(owner,'Front Desk'),profile:{...principal().profile,role:'Front Desk',secondary_roles:['Maintenance Technician']}}),owner);
  for(const role of ['Engineer','Regional Maintenance','Engineering Manager','system_admin','General Manager','Front Desk Lead','Front Desk','Sales Manager','Lead Housekeeper']) assert.throws(()=>store.hoursOwner(principal(owner,role)));
  assert.throws(()=>store.hoursOwner(principal(),true));
  assert.throws(()=>store.hoursOwner({...principal(),profile:{id:other,role:'Chief Engineer',active:true}}));
  assert.throws(()=>store.hoursOwner({...principal(),membership:{user_id:owner,hotel_id:'hotel',active:false}}));
});
test('reject hidden off times, ownership fields and invalid leaves', () => {
  const value=period('2026-10-02');
  value.days[0].attendance={state:'off',start:540,end:1050};
  assert.throws(()=>store.parseHoursPeriod(value));
  value.days[0].attendance={state:'blank'};
  assert.throws(()=>store.parseHoursPeriod({...value,owner_id:other}));
  value.days[0].leave=[{kind:'invented',minutes:60}];
  assert.throws(()=>store.parseHoursPeriod(value));
});
test('local PostgreSQL saves, owner isolation, stale revisions, calendar and rate guards', async () => {
  const db=new PGlite();
  try {
    await db.exec(`create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls; insert into auth.users values ('${owner}'),('${other}');`);
    await db.exec(readFileSync(new URL('../docs/hours-tracker-schema.sql',import.meta.url),'utf8'));
    const client={from(table) {
      assert.equal(table,'cmpri_personal_hours');
      let action='read', value, filters=[];
      const query={select(){return query;},eq(key,val){filters.push([key,val]);return query;},update(val){action='update';value=val;return query;},insert(val){action='insert';value=val;return query;},async maybeSingle(){
        let result;
        try {
          if(action==='insert') result=await db.query('insert into cmpri_personal_hours(owner_id,document,revision) values ($1,$2,$3) returning document,revision',[value.owner_id,JSON.stringify(value.document),value.revision]);
          else {
            assert.equal(filters[0][0],'owner_id');
            result=action==='read'
              ? await db.query('select document,revision from cmpri_personal_hours where owner_id=$1',[filters[0][1]])
              : await db.query('update cmpri_personal_hours set document=$1,revision=$2 where owner_id=$3 and revision=$4 returning document,revision',[JSON.stringify(value.document),value.revision,filters[0][1],filters[1][1]]);
          }
          return {data:result.rows[0]??null,error:null};
        } catch(error) {return {data:null,error};}
      }};return query;
    }};
    assert.equal(await store.readHours(client,principal()),null);
    assert.equal((await db.query('select count(*)::int as n from cmpri_personal_hours')).rows[0].n,0);
    const first=period('2026-10-02'); first.days[0].attendance={...core.NEW_WORK};
    await store.saveHours(client,principal(),{period:first,revision:0});
    assert.equal(await store.readHours(client,principal(other)),null);
    await assert.rejects(()=>store.saveHours(client,principal(),{period:first,revision:0}),e=>e.status===409);
    await assert.rejects(()=>store.saveHours(client,principal(),{period:{...first,start:'2026-10-09'},revision:1}),e=>e.status===400);
    await store.saveHours(client,principal(),{period:period('2026-10-16'),revision:1});
    first.rateCents=2500;
    await assert.rejects(()=>store.saveHours(client,principal(),{period:first,revision:2}),e=>e.status===409);
    const saved=await store.saveHours(client,principal(),{period:first,revision:2,confirmRateChange:true});
    assert.equal(saved.document.periods[1].rateCents,2229);
    assert.equal(saved.document.periods[0].rateCents,2500);
    assert.equal(saved.document.periods.length,2);
    assert.equal(saved.document.anchor,'2026-09-18');
    assert.equal(saved.document.leaveConfigurations.length,0);
    const config={kind:'company-pto',date:'2026-10-01',statementDate:'2026-10-08',coveredThrough:'2026-09-30',evidence:{earnedMinutes:null,carriedInMinutes:null,usedMinutes:null,benefitYearStart:null},minutes:120,earnedMinutesPerWorkedHour:null,policy:'unconfigured',note:'Manual baseline; policy unresolved'};
    const configured=await store.saveHours(client,principal(),{configuration:config,revision:3});
    assert.equal(configured.document.periods.length,2);
    assert.equal(configured.document.leaveConfigurations[0].earnedMinutesPerWorkedHour,null);
    await store.saveHours(client,principal(),{configuration:{...config,date:'2026-10-12',coveredThrough:'2026-10-11',statementDate:'2026-10-15',minutes:60},revision:4});
    const updated=await store.readHours(client,principal());
    assert.equal(updated.document.leaveConfigurations.length,2);
    assert.equal(core.leaveConfigurationAt(updated.document.leaveConfigurations,'company-pto','2026-10-05').minutes,120);
    assert.equal(core.leaveConfigurationAt(updated.document.leaveConfigurations,'illinois-sick','2026-10-05'),null);
    await assert.rejects(()=>store.saveHours(client,principal(),{configuration:{...config,earnedMinutesPerWorkedHour:2},revision:5}),e=>e.status===400);
    // Each additional eligible role starts empty and stores only its own pay, days and leave setup.
    for(const [index,role] of ['Assistant General Manager','Front Desk Manager','Maintenance Technician'].entries()) {
      const id=`00000000-0000-0000-0000-${String(index+3).padStart(12,'0')}`;
      await db.query('insert into auth.users values ($1)',[id]);
      const person=principal(id,role);
      assert.equal(await store.readHours(client,person),null);
      const ownPeriod=period('2026-10-02');ownPeriod.rateCents=1800+index*100;ownPeriod.deductionPercent=10+index;
      ownPeriod.days[index].attendance={state:'off'};
      const ownSaved=await store.saveHours(client,person,{period:ownPeriod,revision:0});
      assert.equal(ownSaved.document.leaveConfigurations.length,0);
      const ownConfig={...config,minutes:30+index};
      await store.saveHours(client,person,{configuration:ownConfig,revision:1});
      const ownRead=await store.readHours(client,person);
      assert.equal(ownRead.document.periods.length,1);
      assert.equal(ownRead.document.periods[0].rateCents,ownPeriod.rateCents);
      assert.equal(ownRead.document.periods[0].deductionPercent,ownPeriod.deductionPercent);
      assert.equal(ownRead.document.periods[0].days[index].attendance.state,'off');
      assert.equal(ownRead.document.leaveConfigurations[0].minutes,30+index);
      await assert.rejects(()=>store.saveHours(client,person,{period:ownPeriod,revision:2,owner_id:owner}),e=>e.status===400);
      assert.equal(JSON.stringify(await store.readHours(client,principal())),JSON.stringify(updated));
    }
    for(const role of ['system_admin','General Manager','Front Desk Lead','Front Desk']) {
      await assert.rejects(()=>store.readHours(client,principal(owner,role)),e=>e.status===403);
      await assert.rejects(()=>store.saveHours(client,principal(owner,role),{period:first,revision:5}),e=>e.status===403);
    }

    await db.exec('set role authenticated');
    await assert.rejects(()=>db.query('select * from cmpri_personal_hours'));
    await assert.rejects(()=>db.query("insert into cmpri_personal_hours values ($1,1,'{\"version\":1}')",[other]));
    await db.exec('reset role; set role anon');
    await assert.rejects(()=>db.query('select * from cmpri_personal_hours'));
  } finally {await db.close();}
});

test('verified legacy dual-role chief keeps own access without granting generic engineers or other admins', () => {
 const id='750f77bf-7d5d-4ca6-8421-e025edea87ba',email='maint.cmpri@hawkeyehotels.com',hotelId='c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
 const p={identity:{id,email},profile:{id,email,role:'system_admin',secondary_roles:['engineer'],active:true},hotelId,membership:{user_id:id,hotel_id:hotelId,role:'admin',active:true}};
 assert.equal(roles.profileIsChiefEngineer(p.profile),false);
 assert.equal(roles.profileCanUseHoursTracker(p.profile),true);
 assert.equal(store.hoursOwner(p),id);
 assert.throws(()=>store.hoursOwner(p,true));
 for(const patch of [{id:other},{email:'other@example.invalid'},{role:'engineer'},{secondary_roles:[]},{secondary_roles:['Engineering Manager']}]) {
  assert.equal(roles.profileCanUseHoursTracker({...p.profile,...patch}),false);
  assert.throws(()=>store.hoursOwner({...p,profile:{...p.profile,...patch}}));
 }
 for(const patch of [{identity:{id:other,email}},{identity:{id,email:'other@example.invalid'}},{membership:{...p.membership,user_id:other}},{membership:{...p.membership,active:false}},{membership:{...p.membership,role:'viewer'}},{hotelId:'other',membership:{...p.membership,hotel_id:'other'}},{profile:{...p.profile,active:false}}]) assert.throws(()=>store.hoursOwner({...p,...patch}));
 const foreign={...p,identity:{id:other,email},profile:{...p.profile,id:other},membership:{...p.membership,user_id:other}};
 assert.throws(()=>store.hoursOwner(foreign));
});
