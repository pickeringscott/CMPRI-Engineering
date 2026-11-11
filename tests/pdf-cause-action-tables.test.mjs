import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {causeActionTableRules} from '../src/lib/server/pdf-cause-action-tables.ts';
import {extractPdfTroubleshootingTables} from '../src/lib/server/pdf-troubleshooting-tables.ts';
import {guideRulesForIssue} from '../src/lib/work-orders/guide-selection.ts';
const ops={constructPath:1,save:2,restore:3,transform:4};
const item=(str,x,y,width=100)=>({str,width,fontName:'body',transform:[10,0,0,10,x,y]});
const rect=(l,b,r,t)=>[22,[new Float32Array([0,l,b,1,r,b,1,r,t,1,l,t,4])]];
function fixture(){
 const paths=[rect(50,650,280,670),rect(280,650,550,670),rect(49.8,550,50.2,670),rect(279.8,550,280.2,670),rect(549.8,550,550.2,670),...[650,610,550].map(y=>rect(50,y-.2,550,y+.2))];
 const items=[item('2. NO FILL ANALYSIS',50,700),item('WARNING: Isolate power before servicing.',50,680),item('POSSIBLE CAUSE',55,655),item('TO CORRECT',285,655),item('The supply valve is',55,638),item('closed.',55,626),item('Open the valve.',285,638),item('A loose connection.',55,598),item('Disconnect power. Inspect the',285,598),item('connection and repair as needed.',285,586),item('Refer to Figure 4.',285,574),item('Please refer to the following page for wiring information.',50,520)];
 return {paths,items,page:{getOperatorList:async()=>({fnArray:paths.map(()=>1),argsArray:paths})}};
}
const run=f=>causeActionTableRules(f.page,f.items,7,ops);
test('closed geometry preserves multiline cause, full actions, safety and references',async()=>{let f=fixture();const [r]=await run(f);assert.deepEqual(r.match,['NO FILL']);assert.deepEqual(r.source_pages,[7]);assert.equal(r.steps.length,2);assert.match(r.steps[0],/The supply valve is closed/);assert.match(r.steps[1],/Disconnect power\. Inspect the connection and repair as needed\. Refer to Figure 4\./);for(const s of r.steps){assert.match(s,/2\. NO FILL ANALYSIS/);assert.match(s,/WARNING: Isolate power/);assert.match(s,/following page for wiring/);}});
test('nonsymptom section, continuation, truncated action, missing border, overlapping text reject',async()=>{
 for(const alter of [f=>f.items[0].str='2. INSTALLATION',f=>f.items.push(item('(Continued)',50,540)),f=>f.items[10].str='Refer to Figure',f=>f.paths.pop(),f=>f.items[4].width=300,f=>f.items.push(item('TO CORRECT',400,655))]){let f=fixture();alter(f);assert.deepEqual(await run(f),[]);}
});
test('missing heading or continuation-only table cannot inherit previous page',async()=>{let f=fixture();f.items=f.items.filter(i=>!i.str.startsWith('2.'));assert.deepEqual(await run(f),[]);});
test('transformed paths and diagram boxes are not table evidence',async()=>{let f=fixture();f.page.getOperatorList=async()=>({fnArray:[ops.transform,...f.paths.map(()=>1)],argsArray:[[2,0,0,2,0,0],...f.paths]});assert.deepEqual(await run(f),[]);});
test('compound symptom title remains intact with no broad alias',async()=>{let f=fixture();f.items[0].str='8. NO MOTOR ROTATION (WITH ACTIVE DRIVE FAULT)';const [r]=await run(f);assert.deepEqual(r.match,['NO MOTOR ROTATION (WITH ACTIVE DRIVE FAULT)']);});
test('actual local manual extracts no-fill and drain with exact scoped source, leaves alphabetic door procedure unsupported', {skip: !process.env.LOCAL_MANUAL_FIXTURE && 'Set LOCAL_MANUAL_FIXTURE to the local Unimac source PDF to run real-PDF validation.'}, async()=>{
 const bytes=new Uint8Array(readFileSync(process.env.LOCAL_MANUAL_FIXTURE));
 const rules=await extractPdfTroubleshootingTables(bytes); const noFill=rules.find(r=>r.source_pages[0]===13),drain=rules.find(r=>r.source_pages[0]===47);
 assert.equal(noFill.steps.length,4);assert.match(noFill.steps[2],/15-pin molex plug in the back of the control module box to the water inlet valves/);assert.match(noFill.steps[3],/point D.*wiring diagram/);
 assert.equal(drain.steps.length,5);assert.match(drain.steps[2],/120V or 220V.*debris/);assert.match(drain.steps[4],/If the above corrections do not clear the drain error, replace the drain valve/);
 for(const s of drain.steps)assert.match(s,/If LED 13.*drain is closed/);
 const knowledge={source:{verified:true},symptom_rules:rules};
 for(const issue of ['No fill analysis','washer not filling','Drain error'])assert.equal(guideRulesForIssue(knowledge,issue).length,1);
 assert.equal(guideRulesForIssue(knowledge,'Door cannot be unlocked').length,0);
});
test('two symptom tables on one page keep their own headings and rows',async()=>{
 const a=fixture(),b=fixture();b.items[0].str='3. DRAIN ERROR';
 for(const i of b.items)i.transform[5]-=250;
 for(const p of b.paths)for(const path of p[1])for(const n of [2,5,8,11])path[n]-=250;
 a.items.push(...b.items);a.paths.push(...b.paths);
 const rules=await run(a);assert.equal(rules.length,2);assert.deepEqual(rules.map(r=>r.match),[['NO FILL'],['DRAIN ERROR']]);
 assert.ok(rules[0].steps.every(s=>!s.includes('DRAIN ERROR')));assert.ok(rules[1].steps.every(s=>!s.includes('NO FILL')));
});

test('complete actions retain trailing safety continuation despite font changes',async()=>{
 const f=fixture();f.items.at(-1).str='WARNING: Disconnect power before servicing.';
 const continuation=item('Do not restore power until all guards are installed.',50,505);continuation.fontName='different-safety-font';f.items.push(continuation);
 const [rule]=await run(f);assert.ok(rule.steps.every(s=>s.includes('Disconnect power before servicing. Do not restore power until all guards are installed.')));
});
test('unlabelled trailing qualification is retained; truncated qualification rejects table',async()=>{
 const f=fixture();f.items.at(-1).str='Only qualified personnel may perform these checks.';
 assert.ok((await run(f))[0].steps.every(s=>s.includes('Only qualified personnel may perform these checks.')));
 f.items.at(-1).str='Only qualified personnel may perform';assert.deepEqual(await run(f),[]);
});
