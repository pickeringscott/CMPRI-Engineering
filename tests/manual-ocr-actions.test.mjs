import test from 'node:test';
import assert from 'node:assert/strict';
import {ocrManualActions} from '../src/lib/server/manual-ocr-actions.ts';
import {guideRulesForIssue} from '../src/lib/work-orders/guide-selection.ts';
test('OCR actions retain their warning, approximation label and original page',()=>{
 const rules=ocrManualActions([{page:4,confidence:95,text:'Door lock stuck\nDisconnect power before servicing.\n1. Inspect the latch.\n2. Check the wiring.'}]);
 const found=guideRulesForIssue({source:{verified:true},symptom_rules:rules},'door lock is stuck');assert.equal(found.length,1);assert.deepEqual(found[0].source_pages,[4]);assert.deepEqual(found[0].steps,['OCR — Door lock stuck — Disconnect power before servicing. — 1. Inspect the latch.','OCR — Door lock stuck — Disconnect power before servicing. — 2. Check the wiring.']);
});
test('low confidence, incomplete lists and charts never become guessed OCR checks',()=>{
 const text='No hot water\n1. Check the supply.\n2. Inspect the valve.';assert.deepEqual(ocrManualActions([{page:1,confidence:50,text}]),[]);assert.deepEqual(ocrManualActions([{page:1,confidence:95,text:text.replace('Inspect the valve.','Inspect the')}]),[]);assert.deepEqual(ocrManualActions([{page:1,confidence:95,text:'Troubleshooting chart\n'+text}]),[]);
});
