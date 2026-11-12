import test from 'node:test';
import assert from 'node:assert/strict';
import {scannedPdf} from './helpers/scanned-pdf.mjs';
import {recognizeManualPages} from '../src/lib/server/manual-ocr.ts';
import {ocrManualActions} from '../src/lib/server/manual-ocr-actions.ts';
import {guideRulesForIssue} from '../src/lib/work-orders/guide-selection.ts';
import {createCanvas} from '@napi-rs/canvas';


test('installed OCR reads an image-only PDF page and preserves its page number',async()=>{
 const result=await recognizeManualPages(scannedPdf(),[1]);assert.equal(result.totalPages,1);assert.equal(result.pages[0].page,1);assert.match(result.pages[0].text,/no hot water/i);assert.match(result.pages[0].text,/check the water supply valve/i);assert.ok(result.pages[0].confidence>85);const rules=ocrManualActions(result.pages);const matches=guideRulesForIssue({source:{verified:true},symptom_rules:rules},'no hot water');assert.equal(matches.length,1);assert.equal(matches[0].steps.length,2);assert.ok(matches[0].steps.every(step=>step.startsWith('OCR — ')));assert.deepEqual(matches[0].source_pages,[1]);
});
test('OCR rejects invalid sources, duplicate pages and out-of-range pages',async()=>{
 await assert.rejects(recognizeManualPages(new Uint8Array([1,2]),[1]));const pdf=scannedPdf();await assert.rejects(recognizeManualPages(pdf,[1,1]));await assert.rejects(recognizeManualPages(pdf,[2]));
});
test('OCR reads a high-resolution scanned page instead of silently discarding it',async()=>{
 const canvas=createCanvas(5000,4000),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,5000,4000);ctx.fillStyle='black';ctx.font='bold 250px Arial';ctx.fillText('CHECK WATER SUPPLY',300,1900);
 const result=await recognizeManualPages(scannedPdf({jpeg:canvas.toBuffer('image/jpeg'),width:5000,height:4000,pageHeight:560}),[1]);canvas.width=0;canvas.height=0;assert.match(result.pages[0].text,/check water supply/i);
});
