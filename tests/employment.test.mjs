import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { validateEmployment } from '../src/lib/employment-validation.mjs';
import { canReviewEmployment } from '../src/lib/employment-access.ts';
const fixture=()=>({name:'RELEASE TEST ONLY',email:'employment-release@example.invalid',phone:'(217) 555-0123',history:'Test training',example:'No repair experience yet.',workingDays:['Mon'],skills:{hvac:'Personally performed',plumbing:'Assisted',electrical:'Not done',appliances:'Not done'},interview:{Tue:['AM'],Thu:['PM']}});
test('validation preserves approved fields and rejects malformed requests',()=>{
 assert.deepEqual(validateEmployment(fixture()).value.interview,{Tue:['AM'],Thu:['PM']});
 for(const patch of [{phone:'217555012'},{email:'bad'},{example:'x'.repeat(1501)},{workingDays:[]},{interview:{Tue:[]}},{interview:{Tue:['night']}},{skills:{hvac:'Perform'}},{name:' '}])assert.equal(validateEmployment({...fixture(),...patch}).ok,false);
 assert.equal(validateEmployment({...fixture(),phone:'',example:'x'.repeat(1500)}).ok,true);
});
test('review identity excludes personal account and matching display names',()=>{
 assert.equal(canReviewEmployment({id:'750f77bf-7d5d-4ca6-8421-e025edea87ba',email:'maint.cmpri@hawkeyehotels.com'}),true);
 assert.equal(canReviewEmployment({id:'bb7efebe-68bc-4278-90f0-a8497925dd17',email:'maint.cmpri@hawkeyehotels.com'}),false);
 assert.equal(canReviewEmployment({id:'750f77bf-7d5d-4ca6-8421-e025edea87ba',email:'personal@example.invalid'}),false);
});
test('database blocks all direct applicant/staff access and throttles submissions',async()=>{
 const db=new PGlite();
 try{
 await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
 await db.exec(readFileSync(new URL('../scripts/employment-schema.sql',import.meta.url),'utf8'));
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  for(const sql of ['select * from public.employment_applications',"insert into public.employment_applications(answers) values ('{}')",'delete from public.employment_applications',"select public.submit_employment_application('{}')"]){await assert.rejects(db.exec(sql),/permission denied/);}
  await db.exec('reset role');
 }
 await db.exec('set role service_role');
 for(let i=0;i<3;i++)await db.query('select public.submit_employment_application($1::jsonb)',[JSON.stringify(fixture())]);
 await assert.rejects(db.query('select public.submit_employment_application($1::jsonb)',[JSON.stringify(fixture())]),/Submission limit reached/);
 const {rows}=await db.query('select answers from public.employment_applications');assert.equal(rows.length,3);assert.deepEqual(rows[0].answers.interview,{Tue:['AM'],Thu:['PM']});
 }finally{await db.close();}
});
