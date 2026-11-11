import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticSectionRules} from '../src/lib/server/pdf-diagnostic-sections.ts';
import {guideRulesForIssue} from '../src/lib/work-orders/guide-selection.ts';

const item=(x,y,str,fontName='body')=>({str,fontName,transform:[1,0,0,1,x,y]});
test('diagnostic headings preserve source condition and complete actions without mixing columns',()=>{
 const items=[item(50,700,'Thermistor Diagnosing','heading'),item(50,677,'If the thermistor fails, the compressor will not'),item(50,664,'come on for cooling.'),item(50,640,'Check Fault Codes','heading'),item(50,617,'Check the fault code and record the result.'),item(50,594,'Verify Operation','heading'),item(50,571,'Enter service mode and check the reading.'),item(50,548,'Thermistor Removal','heading'),item(50,525,'Remove the cover.'),item(340,617,'Replace a different component.')];
 const rules=diagnosticSectionRules(items,27,612);const matched=guideRulesForIssue({source:{verified:true},symptom_rules:rules},'A/C not cooling');assert.equal(matched.length,1);assert.equal(matched[0].steps.length,2);assert.deepEqual(matched[0].source_pages,[27]);assert.ok(matched[0].steps.every(step=>step.startsWith('If the thermistor fails, the compressor will not come on for cooling.')));assert.ok(matched[0].steps.every(step=>!step.includes('different component')&&!step.includes('Remove the cover')));
});
test('a diagnostic paragraph cut off by a page boundary is not turned into an instruction',()=>{
 const items=[item(50,700,'Sensor Diagnosing','heading'),item(50,677,'A failed sensor causes no cooling.'),item(50,650,'Check Fault Codes','heading'),item(50,627,'Check the fault code and'),item(50,604,'Verify Operation','heading')];assert.deepEqual(diagnosticSectionRules(items,1,612),[]);
});
