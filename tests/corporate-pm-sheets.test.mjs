import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root=fileURLToPath(new URL('../src/',import.meta.url));
const months=['JAN','FEB','MAR','APR','MAY','JUNE','JULY','AUG','SEPT','OCT','NOV','DEC'];

function fixture(config={}) {
  const calls=[];
  let janValues=[['Room','Daily property check','Weekly property check'],['409','FALSE','TRUE'],['410','TRUE','FALSE']];
  let janFormulas=[['','',''],['','',''],['','','']];
  const headers=months.map(title=>({properties:{title}}));
  const modulePath=path.join(root,'lib/server/corporate-pm.ts');
  const exports={};
  const source=ts.transpileModule(readFileSync(modulePath,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const googleSheetsRequest=async(_spreadsheetId,requestPath,init={})=>{
    calls.push({path:requestPath,init});
    if(requestPath.startsWith('?fields='))return {sheets:headers};
    if(requestPath.startsWith('/values:batchGet?')){
      const query=new URL(`https://test.invalid${requestPath}`).searchParams;
      const result=query.getAll('ranges').map(range=>{
        const sheet=decodeURIComponent(range).match(/^'([^']+)'/)?.[1] || '';
        const formulas=query.get('valueRenderOption')==='FORMULA';
        return {values:sheet==='JAN'?(formulas?janFormulas:janValues):[]};
      });
      return {valueRanges:result};
    }
    if(requestPath.startsWith('/values/')){
      const range=decodeURIComponent(requestPath.split('?')[0].slice('/values/'.length));
      if(init.method==='PUT'){
        const cell=range.match(/!([A-Z]+)(\d+)$/);
        assert.ok(cell,'expected a single-cell range');
        const column=[...cell[1]].reduce((value,letter)=>value*26+letter.charCodeAt(0)-64,0)-1;
        const row=Number(cell[2])-1;
        janValues[row][column]=init.body ? JSON.parse(init.body).values[0][0] ? 'TRUE' : 'FALSE' : '';
        return {};
      }
      return {values:range.includes('JAN')?(requestPath.includes('FORMULA')?janFormulas:janValues):[]};
    }
    throw new Error(`Unexpected Sheets request ${requestPath}`);
  };
  vm.runInNewContext(source,{exports,process:{env:{
    CMPRI_CORPORATE_PM_SPREADSHEET_ID:config.spreadsheetId===undefined?'private-pm-sheet':config.spreadsheetId,
    CMPRI_INTEGRATIONS_SAFE_MODE:config.safeMode?'true':'false',
  }},URL,URLSearchParams,Date,Error,encodeURIComponent,console,require(name){
    if(name==='server-only')return {};
    if(name==='@/lib/server/google-sheets')return {googleSheetsRequest};
    if(name==='@/lib/server/integrations-safe-mode')return {
      IntegrationConfigurationError:class IntegrationConfigurationError extends Error {constructor(message){super(message);this.name='IntegrationConfigurationError';}},
      isIntegrationsSafeMode:()=>config.safeMode===true,
      safeModeBlocked:(integration,action)=>({ok:true,safeMode:true,blocked:true,blockedAction:action,message:`blocked ${integration}`}),
    };
    throw new Error(`Unexpected import ${name}`);
  }});
  return {api:exports,calls,getJan:()=>janValues,setJan(values,formulas){janValues=values;janFormulas=formulas;}};
}

test('Corporate PM reads the selected monthly tab without exposing credentials',async()=>{
  const f=fixture();const result=await f.api.readCorporatePmSheet('JAN');
  assert.equal(result.ok,true);assert.equal(result.sheet,'JAN');
  assert.equal(result.values[1][1],'FALSE');assert.equal(result.formulas[1][1],'');
  assert.equal(JSON.stringify(result).includes('private-pm-sheet'),false);
  await assert.rejects(()=>f.api.readCorporatePmSheet('unknown'),/not a supported monthly sheet/);
});

test('room PM reads return matching daily and weekly cells from monthly sheets',async()=>{
  const f=fixture();const result=await f.api.readCorporatePmRoom('409');
  assert.deepEqual(JSON.parse(JSON.stringify(result.tasks.map(({sheet,row,column,label,checked})=>({sheet,row,column,label,checked})))),[
    {sheet:'JAN',row:2,column:2,label:'Daily property check',checked:false},
    {sheet:'JAN',row:2,column:3,label:'Weekly property check',checked:true},
  ]);
  assert.equal(f.calls.filter(({path})=>path.startsWith('/values:batchGet')).length,2);
});

test('formula cells are omitted from read-only room checklist data',async()=>{
  const f=fixture();
  f.setJan([['Room','Daily property check','Weekly property check'],['409','FALSE','FALSE']], [['','',''],['','=FORMULA','']]);
  const room=await f.api.readCorporatePmRoom('409');
  assert.deepEqual(JSON.parse(JSON.stringify(room.tasks.map(task=>task.column))),[3]);
});

test('legacy Corporate PM adapter has no write method',async()=>{
  const f=fixture();
  assert.equal(typeof f.api.setCorporatePmCheckbox,'undefined');
  assert.equal(f.calls.some(({init})=>init.method==='PUT'),false);
});

test('Corporate PM reports a missing spreadsheet deployment setting',async()=>{
  const f=fixture({spreadsheetId:''});
  await assert.rejects(()=>f.api.readCorporatePmSheet('JAN'),error=>error.name==='IntegrationConfigurationError' && /CMPRI_CORPORATE_PM_SPREADSHEET_ID/.test(error.message));
});
