import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root=fileURLToPath(new URL('../src/',import.meta.url));
function fixture(body,config={}) {
  const calls=[];
  function load(filename) {
    const exports={};
    vm.runInNewContext(ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
      exports,URL,AbortSignal,process:{env:{CMPRI_INTEGRATIONS_SAFE_MODE:'false',CMPRI_CORPORATE_PM_SPREADSHEET_ID:'private-sheet-id',...(config.env||{})}},
      fetch:async()=>{calls.push('network');return {ok:true,status:200,json:async()=>({}),text:async()=>'{}'};},
      require(name){
        if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
        if(name==='server-only')return {};
        if(name==='@/lib/server/request-auth')return {authenticatedUser:async()=>({profile:{active:true,role:'System Administrator'}})};
        if(name==='@/lib/server/auth'){
          const database={from:table=>{
            if(table!=='work_orders')throw new Error(`Unexpected database table ${table}`);
            const query={select(){return query;},eq(){return query;},maybeSingle:async()=>({data:config.workOrder??{id:'work-order-id',room:'409',technician_name:'Engineer'},error:null})};
            return query;
          }};
          const p={principal:{identity:{id:'actor'},profile:{active:true,role:config.role||'System Administrator',full_name:config.fullName||'Engineer'},membership:{hotel_id:'hotel'},permissions:[]},admin:database};
          return {requireUser:async()=>p};
        }
        if(name==='@/lib/server/access')return {allows:(_principal,capability)=>capability==='view_dashboard'||capability==='edit_tickets'||capability==='operate_integrations'};
        if(name==='@/lib/server/corporate-pm')return {
          CORPORATE_PM_MONTHS:['JAN','FEB','MAR','APR','MAY','JUNE','JULY','AUG','SEPT','OCT','NOV','DEC'],
          readCorporatePmSheet:async sheet=>{calls.push(['read',sheet]);return {ok:true,sheet,values:[['Room','Daily check'],['409','FALSE']],formulas:[['',''],['','']],timestamp:'2026-03-01T00:00:00.000Z'};},
          readCorporatePmRoom:async room=>{calls.push(['room',room]);return {ok:true,room,tasks:[{sheet:'JAN',row:2,column:2,label:'Daily check',checked:false}],fetchedAt:'2026-03-01T00:00:00.000Z'};},
          setCorporatePmCheckbox:async(...args)=>{calls.push(['write',...args]);return {ok:true,...Object.fromEntries(['sheet','row','column','checked'].map((key,index)=>[key,args[index]]))};},
        };
        if(name==='@/lib/server/room-ranker')return {callRoomRanker:async()=>({ok:true,rooms:[]})};
        if(name==='@/lib/server/roles')return {roleKey:role=>String(role).toLowerCase()==='system administrator'?'system_admin':String(role).toLowerCase()};
        let file=name.startsWith('@/')?path.join(root,name.slice(2)):path.resolve(path.dirname(filename),name);
        if(!existsSync(file))file+='.ts';
        return load(file);
      },
    });return exports;
  }
  const request={url:'https://test.invalid/api/corporate-pm',headers:new Headers({authorization:'Bearer token'}),json:async()=>{if(config.badJson)throw new SyntaxError('Invalid JSON');return body;}};
  return {calls,handlers:load(path.join(root,'app/api/corporate-pm/route.ts')),load,request};
}

for(const body of [null,[],{},42])test(`legacy Corporate PM rejects direct write ${JSON.stringify(body)}`,async()=>{
  const f=fixture(body);const response=await f.handlers.PATCH(f.request);
  assert.equal(response.status,409);assert.equal(f.calls.length,0);
});

test('legacy Corporate PM does not parse or write direct updates',async()=>{
  const f=fixture(null,{badJson:true});const response=await f.handlers.PATCH(f.request);
  assert.equal(response.status,409);assert.equal(f.calls.length,0);
});

test('only system administrators can open the monthly Corporate PM manager',async()=>{
  const f=fixture(null,{role:'Chief Engineer'});
  const response=await f.handlers.GET({...f.request,url:'https://test.invalid/api/corporate-pm?sheet=JAN'});
  assert.equal(response.status,403);assert.equal(f.calls.length,0);
});

test('work-order room reads return only room checklist fields, not credentials',async()=>{
  const f=fixture(null,{role:'Maintenance Technician'});
  const response=await f.handlers.GET({...f.request,url:'https://test.invalid/api/corporate-pm?room=409'});
  assert.equal(response.status,200);assert.equal(response.body.tasks[0].label,'Daily check');
  assert.equal(response.body.can_edit,false);
  assert.equal(JSON.stringify(response.body).includes('private-sheet-id'),false);
  assert.equal(JSON.stringify(response.body).includes('private_key'),false);
});

test('Corporate PM writes are retired in favor of the personal live PM review flow',async()=>{
  const body={action:'setcheckbox',sheet:'JAN',row:2,column:2,checked:true,spreadsheetId:'attacker',key:'attacker'};
  const f=fixture(body);const response=await f.handlers.PATCH(f.request);
  assert.equal(response.status,409);
  assert.equal(f.calls.length,0);
});

test('Corporate PM rejects unsupported completion actions',async()=>{
  const f=fixture({action:'completeroompm',room:'409',quarter:'Q1'});
  const response=await f.handlers.PATCH(f.request);
  assert.equal(response.status,409);assert.equal(f.calls.length,0);
});

test('work-order PM endpoint never writes directly to the corporate workbook',async()=>{
  const body={action:'setcheckbox',sheet:'JAN',row:2,column:2,checked:true,expectedChecked:false};
  const f=fixture(body,{role:'Technician'});
  const handler=f.load(path.join(root,'app/api/work-orders/[id]/preventive-maintenance/route.ts'));
  const response=await handler.PATCH(f.request,{params:Promise.resolve({id:'work-order-id'})});
  assert.equal(response.status,409);
  assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==='write'),false);
});

test('work-order PM endpoint directs checklist changes to explicit review',async()=>{
  const body={action:'setcheckbox',sheet:'JAN',row:2,column:2,checked:true};
  const f=fixture(body,{role:'Technician'});
  const handler=f.load(path.join(root,'app/api/work-orders/[id]/preventive-maintenance/route.ts'));
  const response=await handler.PATCH(f.request,{params:Promise.resolve({id:'work-order-id'})});
  assert.equal(response.status,409);
  assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==='write'),false);
});

test('work-order PM commits reject a technician assigned to another staff member',async()=>{
  const body={action:'setcheckbox',sheet:'JAN',row:2,column:2,checked:true,expectedChecked:false};
  const f=fixture(body,{role:'Technician',fullName:'Other Engineer',workOrder:{id:'work-order-id',room:'409',technician_name:'Assigned Engineer'}});
  const handler=f.load(path.join(root,'app/api/work-orders/[id]/preventive-maintenance/route.ts'));
  const response=await handler.PATCH(f.request,{params:Promise.resolve({id:'work-order-id'})});
  assert.equal(response.status,409);
  assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==='write'),false);
});
