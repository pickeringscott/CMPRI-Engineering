import {employmentDepartments,canReviewEmploymentDepartment} from '../src/lib/employment-access.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {validateEmployment} from '../src/lib/employment-validation.mjs';
const answers={department:'maintenance',name:'Fictional applicant',email:'fixture@example.invalid',phone:'',history:'Training',example:'Assisted',workingDays:['Mon'],skills:{hvac:'Assisted',plumbing:'Not done',electrical:'Not done',appliances:'Not done'},interview:{Tue:['AM']}};
test('both complete questionnaires validate without deriving answers from attachments',()=>{
 assert.equal(validateEmployment(answers).ok,true);
 assert.equal(validateEmployment({...answers,department:'front',skills:{guests:'Assisted',systems:'Not done',payments:'Not done'}}).ok,true);
 assert.equal(validateEmployment({...answers,department:'front'}).ok,false);
});
test('private original PDF submission is atomic, idempotent and rejects changed retries',async()=>{
 const db=new PGlite();try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 await db.exec(readFileSync(new URL('../scripts/employment-schema.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('./fixtures/employment-private-resume.sql',import.meta.url),'utf8'));
 const id='00000000-0000-4000-8000-000000000001',bytes=Buffer.from('%PDF-1.7\nOriginal fixture bytes\n%%EOF');
 await db.exec('set role service_role');
 const submit=(value=answers)=>db.query('select submit_employment_with_resume($1,$2,$3,$4)',[id,JSON.stringify(value),'résumé.pdf',bytes]);
 await submit();await submit();
 assert.equal((await db.query('select count(*)::integer n from employment_applications')).rows[0].n,1);
 const saved=(await db.query('select original_pdf from employment_resumes')).rows[0].original_pdf;assert.deepEqual(Buffer.from(saved),bytes);
 await assert.rejects(submit({...answers,name:'Changed'}),/identity conflict/);
 for(const role of ['anon','authenticated']){await db.exec('reset role;set role '+role);await assert.rejects(db.query('select * from employment_resumes'),/permission denied/);await assert.rejects(submit(),/permission denied/);}
 }finally{await db.close();}
});

test('department review grants only the two established Front Desk management roles',()=>{
 const user={id:'other',email:'manager@example.invalid'};
 for(const role of ['front_desk_manager','Assistant General Manager','assistant_manager']){assert.deepEqual(employmentDepartments(user,{role}),['front']);assert.equal(canReviewEmploymentDepartment(user,{role},'maintenance'),false);}
 for(const role of ['front_desk','manager','senior_management','system_admin','engineer','technician'])assert.deepEqual(employmentDepartments(user,{role}),[]);
 assert.deepEqual(employmentDepartments(user,{role:'front_desk',secondary_roles:['Front Desk Manager']}),['front']);
 const maint={id:'750f77bf-7d5d-4ca6-8421-e025edea87ba',email:'maint.cmpri@hawkeyehotels.com'};
 assert.deepEqual(employmentDepartments(maint,{role:'system_admin'}),['maintenance']);assert.equal(canReviewEmploymentDepartment(maint,{role:'system_admin'},'front'),false);
});
