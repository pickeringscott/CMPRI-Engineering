import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as access from '../src/lib/employment-access.ts';
import {validateEmployment} from '../src/lib/employment-validation.mjs';
function handler(path,admin,auth){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Response,Request,File,Buffer,crypto,process,URL,require(name){
 if(name==='next/server')return {NextResponse:Response};
 if(name==='@/lib/server/supabase-admin')return {createSupabaseAdmin:()=>admin};
 if(name==='@/lib/server/auth')return {requireUserAttempt:async()=>auth};
 if(name==='@/lib/employment-access')return access;
 if(name==='@/lib/employment-validation.mjs')return {validateEmployment};
 throw Error(name);
}});return exports;}
test('actual multipart submission → authorized original PDF response; unauthorized and wrong-department access denied',async()=>{
 const bytes=Buffer.from('%PDF-1.7\noriginal immutable bytes\n%%EOF');let stored;
 const admin={rpc:async(name,args)=>{assert.equal(name,'submit_employment_with_resume');stored=args;return {error:null};},from(table){const query={select(){return query;},eq(){return query;},async maybeSingle(){return {data:table==='employment_applications'?{department:stored.p_answers.department}:{file_name:stored.p_file_name,original_pdf:stored.p_pdf},error:null};}};return query;}};
 const answers={department:'front',name:'Local test only',email:'fixture@example.invalid',phone:'',history:'Training',example:'Assisted',workingDays:['Mon'],skills:{guests:'Assisted',systems:'Not done',payments:'Not done'},interview:{Tue:['AM']}};
 const form=new FormData();form.set('answers',JSON.stringify(answers));form.set('submissionId','00000000-0000-4000-8000-000000000001');form.set('resume',new File([bytes],'original.pdf',{type:'application/pdf'}));
 const post=handler('src/app/api/employment/route.ts',admin,{ok:false});const request=new Request('https://www.cmpri-engineering.com/api/employment',{method:'POST',headers:{origin:'https://www.cmpri-engineering.com',host:'www.cmpri-engineering.com'},body:form});assert.equal((await post.POST(request)).status,201);assert.deepEqual(Buffer.from(stored.p_pdf.slice(2),'hex'),bytes);
 const req={nextUrl:new URL('https://www.cmpri-engineering.com/api/employment/resume?id='+stored.p_id)};
 const auth={ok:true,admin,principal:{identity:{id:'front-manager',email:'manager@example.invalid'},profile:{role:'front_desk_manager',active:true}}};
 const pdf=handler('src/app/api/employment/resume/route.ts',admin,auth);const response=await pdf.GET(req);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.match(response.headers.get('content-disposition'),/original.pdf/);
 assert.equal((await handler('src/app/api/employment/resume/route.ts',admin,{ok:false}).GET(req)).status,403);
 stored.p_answers.department='maintenance';assert.equal((await pdf.GET(req)).status,404);
 assert.equal((await handler('src/app/api/employment/resume/route.ts',admin,{...auth,mcp:true}).GET(req)).status,403);
});
