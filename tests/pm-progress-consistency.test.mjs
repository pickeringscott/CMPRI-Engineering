import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pmRoutineChecked} from '../src/lib/pm/routine-responses.ts';
const source=fs.readFileSync(new URL('../src/app/engineering/preventive-maintenance/page.tsx',import.meta.url),'utf8');
// Execute the actual component predicates and aggregate, with fixture data dependencies.
const status=source.slice(source.indexOf('  function routineStatus('),source.indexOf('  function canEditPeriod('))
 .replace('template: PmTemplate, period: string, itemId: string','template, period, itemId');
const aggregate=source.slice(source.indexOf('    const routineTasks =',source.indexOf('const overallProgress')),source.indexOf('\n  }, [approvedInspections',source.indexOf('const overallProgress')));
function run({monthly=true,pending=false,submitted=false,ownPending=false,sourceChecked=true,sync=false}={}){
 const template={id:monthly?'workbook:monthly:test':'daily',checklist:[{id:'task',source:'form'},{id:'summary'}]};
 const context={PM_TEMPLATES:[template],PM_DAILY_TEMPLATE_ID:'daily',PM_WEEKLY_TEMPLATE_ID:'weekly',monthTemplates:monthly?[template]:[],weekStart:'2026-11-01',templatePeriodsForWeek:()=>['2026-11-01'],isPmRoutineSummary:id=>id==='summary',entryFor:()=>({status:'approved',responses:{task:ownPending?'follow-up':true}}),attachedAttention:()=>submitted,attachedPendingIssue:()=>pending,issueLinks:[],pmSubmittedIssueLinks:()=>submitted?[{id:'ticket'}]:[],linkedRoutineCompletion:()=>sourceChecked,approvedInspections:[],spreadsheetSyncEnabled:sync,sourceRoutineStatus:()=>sourceChecked,liveWorkbook:{},pmRoutineChecked};
 vm.createContext(context);
 return vm.runInContext(status+'\n({row:routineStatus(PM_TEMPLATES[0],weekStart,"task"),progress:(()=>{'+aggregate+'})()})',context);
}
for(const sync of [false,true]) test(`pending attached issue cannot count prior completion (sync=${sync})`,()=>{
 const result=run({pending:true,sync}); assert.equal(result.row,false); assert.equal(result.progress.complete,0); assert.equal(result.progress.total,1); assert.equal(result.progress.percent,0);
});
test('submitted attention and direct pending issue stay uncounted',()=>{
 for(const state of [{submitted:true},{ownPending:true,sync:true}]){const r=run(state);assert.equal(r.row,false);assert.equal(r.progress.complete,0);}
});
test('unaffected checked monthly and daily tasks retain count; summary excluded',()=>{
 for(const state of [{},{monthly:false,pending:true}]){const r=run(state);assert.equal(r.row,true);assert.equal(r.progress.complete,1);assert.equal(r.progress.total,1);assert.equal(r.progress.percent,100);}
});
