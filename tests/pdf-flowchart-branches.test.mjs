import test from 'node:test';
import assert from 'node:assert/strict';
import {flowchartBranches} from '../src/lib/server/pdf-flowchart-branches.ts';
import {guideRulesForIssue} from '../src/lib/work-orders/guide-selection.ts';

const ops={constructPath:1,transform:2,save:3,restore:4};
const rect=(l,b,r,t)=>new Float32Array([0,l,t,1,r,t,1,r,b,1,l,b,4]);
const item=(x,y,str)=>({str,transform:[1,0,0,1,x,y]});
function fixture({linked=true,label=true,ambiguous=false}={}){
 const paths=[rect(20,600,120,640),rect(150,600,250,640)];if(linked)paths.push(new Float32Array([0,120,620,1,150,620]));
 const items=[item(20,740,'TROUBLESHOOTING CHART'),item(40,700,'NO COOLING OPERATION'),item(30,620,'Voltage present?'),item(160,620,'Check supply.'),...(label?[item(128,608,'No')]:[]),...(ambiguous?[item(132,609,'Yes')]:[])];
 return {items,page:{getOperatorList:async()=>({fnArray:[ops.save,ops.transform,ops.constructPath,ops.restore],argsArray:[null,[2,0,0,2,0,0],[0,paths.map(path=>{const out=Array.from(path);for(let i=0;i<out.length;){const op=out[i++];if(op===0||op===1){out[i]/=2;out[i+1]/=2;i+=2;}}return Float32Array.from(out);})],null]})}};
}
test('a chart branch requires a drawn connection and preserves its explicit answer',async()=>{
 const {page,items}=fixture();const rules=await flowchartBranches(page,items,4,ops);const matches=guideRulesForIssue({source:{verified:true},symptom_rules:rules},'unit not cooling');assert.equal(matches.length,1);assert.deepEqual(matches[0].steps,['NO COOLING OPERATION — Voltage present? — No: Check supply.']);assert.deepEqual(matches[0].source_pages,[4]);
});
test('unconnected, unlabelled and ambiguous nodes never become chart checks',async()=>{
 for(const variant of [{linked:false},{label:false},{ambiguous:true}]){const {page,items}=fixture(variant);assert.deepEqual(await flowchartBranches(page,items,4,ops),[]);}
});


test('the same structure also handles a future non-HVAC equipment symptom',async()=>{
 const {page,items}=fixture();items.find(entry=>entry.str==='NO COOLING OPERATION').str='NO HOT WATER';
 const rules=await flowchartBranches(page,items,7,ops);const matches=guideRulesForIssue({source:{verified:true},symptom_rules:rules},'no hot water');assert.equal(matches.length,1);assert.equal(matches[0].steps[0],'NO HOT WATER — Voltage present? — No: Check supply.');
});


test('chart subtitles stay with checks when a manual has multiple equipment models',async()=>{
 const {page,items}=fixture();items.push(item(50,720,'MODELS A AND B'));
 const rules=await flowchartBranches(page,items,8,ops);assert.equal(rules[0].steps[0],'MODELS A AND B — NO COOLING OPERATION — Voltage present? — No: Check supply.');
});

test('documents without a diagnostic chart or with several possible titles are not guessed',async()=>{
 const first=fixture();assert.deepEqual(await flowchartBranches(first.page,first.items.filter(entry=>entry.str!=='TROUBLESHOOTING CHART'),4,ops),[]);
 const second=fixture();second.items.push(item(40,680,'NO HOT WATER'));assert.deepEqual(await flowchartBranches(second.page,second.items,4,ops),[]);
});

test('vertical branches keep their yes/no answer and never skip an intervening box',async()=>{
 const paths=[rect(20,600,120,640),rect(20,530,120,570),new Float32Array([0,70,650,1,70,520])];
 const items=[item(20,740,'TROUBLESHOOTING CHART'),item(40,700,'NO HOT WATER'),item(30,620,'Supply on?'),item(74,582,'Yes'),item(30,550,'Check valve.')];
 const page={getOperatorList:async()=>({fnArray:[ops.constructPath],argsArray:[[0,paths]]})};
 const rules=await flowchartBranches(page,items,3,ops);assert.deepEqual(rules[0].steps,['NO HOT WATER — Supply on? — Yes: Check valve.']);
 paths.push(rect(20,578,120,590));items.push(item(30,584,'Another check'));
 assert.deepEqual(await flowchartBranches(page,items,3,ops),[]);
});

test('mixed-case chart headings and ordinary reordered descriptions work for new equipment types',async()=>{
 const {page,items}=fixture();const title=items.find(entry=>entry.str==='NO COOLING OPERATION');title.str='Low Water Pressure';title.transform[0]=title.transform[3]=2;
 const rules=await flowchartBranches(page,items,9,ops);const found=guideRulesForIssue({source:{verified:true},symptom_rules:rules},'water pressure is low');
 assert.equal(found.length,1);assert.match(found[0].steps[0],/^Low Water Pressure — Voltage present\?/);
});

test('a plain-language complaint can find a generic low-pressure chart',async()=>{
 const {page,items}=fixture();const title=items.find(entry=>entry.str==='NO COOLING OPERATION');title.str='LOW WATER PRESSURE';
 const rules=await flowchartBranches(page,items,10,ops);
 assert.equal(guideRulesForIssue({source:{verified:true},symptom_rules:rules},'water pressure is too low').length,1);
});

function splitDiamond({broken=false,label=true,header='Troubleshooting',title='6. Heating Element Does Not Heat or Burner Does Not Ignite'}={}) {
 const line=(a,b)=>new Float32Array([0,...a,1,...b]);
 const paths=[line([20,620],[70,645]),line([70,645],[120,620]),line([120,620],[70,595]),...(!broken?[line([70,595],[20,620])]:[]),rect(150,600,250,640),line([120,620],[145,620]),line([145,620],[150,620])];
 const heading=item(20,700,title);heading.transform[0]=heading.transform[3]=2;
 const items=[item(20,740,header),heading,item(40,620,'Supply on?'),item(160,620,'Check valve.'),...(label?[item(130,610,'Yes')]:[])];
 return {items,page:{getOperatorList:async()=>({fnArray:[ops.constructPath],argsArray:[[0,paths]]})}};
}
test('numbered heating charts with separately drawn diamond edges restore conditional checklist steps',async()=>{
 const {page,items}=splitDiamond();
 const rules=await flowchartBranches(page,items,25,ops);
 assert.equal(rules.length,1);
 assert.deepEqual(rules[0].steps,['Heating Element Does Not Heat or Burner Does Not Ignite — Supply on? — Yes: Check valve.']);
 assert.deepEqual(rules[0].source_pages,[25]);
 assert.equal(guideRulesForIssue({source:{verified:true},symptom_rules:rules},'Heat error on dryer').length,1);
 for(const issue of ['dryer door broken','heating works normally','error code E99','Maybe a heat error'])assert.equal(guideRulesForIssue({source:{verified:true},symptom_rules:rules},issue).length,0,issue);
});
test('generic headings never promote open diamonds, missing answers or unrelated numbered sections',async()=>{
 for(const variant of [{broken:true},{label:false},{header:'Installation'},{title:'6. Electrical Connections'}]){
  const {page,items}=splitDiamond(variant);assert.deepEqual(await flowchartBranches(page,items,25,ops),[]);
 }
});

test('connector answers touching a node never become part of its question',async()=>{
 const {page,items}=splitDiamond();items.push(item(70,645,'No'));
 const rules=await flowchartBranches(page,items,25,ops);
 assert.deepEqual(rules[0].steps,['Heating Element Does Not Heat or Burner Does Not Ignite — Supply on? — Yes: Check valve.']);
});

test('multiple columns keep the PDF text sequence rather than interleaving by vertical position',async()=>{
 const paths=[rect(20,600,120,640),rect(150,600,250,640),new Float32Array([0,120,620,1,150,620]),rect(300,630,400,670),rect(430,630,530,670),new Float32Array([0,400,650,1,430,650])];
 const items=[item(20,740,'TROUBLESHOOTING CHART'),item(40,700,'NO HEAT'),item(30,620,'First check?'),item(160,620,'First action.'),item(310,650,'Later check?'),item(440,650,'Later action.'),item(130,610,'Yes'),item(410,640,'No')];
 const page={getOperatorList:async()=>({fnArray:[ops.constructPath],argsArray:[[0,paths]]})};
 const rules=await flowchartBranches(page,items,25,ops);
 assert.deepEqual(rules[0].steps,['NO HEAT — First check? — Yes: First action.','NO HEAT — Later check? — No: Later action.']);
});
