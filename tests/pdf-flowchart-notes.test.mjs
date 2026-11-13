import test from 'node:test';
import assert from 'node:assert/strict';
import {flowchartPrerequisites} from '../src/lib/server/pdf-flowchart-notes.ts';
import {guideRulesForIssue} from '../src/lib/work-orders/guide-selection.ts';

const item=(x,y,str)=>({str,transform:[1,0,0,1,x,y]});
const source=[item(215,668,'NO COOLING OPERATION'),item(362,632,'Before continuing'),item(368,624,'check for Error'),item(375,616,'Codes, see'),item(361,608,'electronics control'),item(368,600,'diagnostics on'),item(381,592,'page 16'),item(400,560,'No'),item(440,550,'Replace board')];
test('chart prerequisite is preserved without converting conditional branches',()=>{
 const rules=flowchartPrerequisites(source,41);const matched=guideRulesForIssue({source:{verified:true},symptom_rules:rules},'not cooling');assert.equal(matched.length,1);assert.deepEqual(matched[0].steps,['NO COOLING OPERATION — Before continuing check for Error Codes, see electronics control diagnostics on page 16']);assert.deepEqual(matched[0].source_pages,[41]);assert.ok(!matched[0].steps[0].includes('Replace board'));
});
test('branch-specific or incomplete chart notes are not promoted to unconditional checks',()=>{
 assert.deepEqual(flowchartPrerequisites([...source,item(300,640,'No')],41),[]);assert.deepEqual(flowchartPrerequisites(source.filter(x=>x.str!=='page 16'),41),[]);
});
