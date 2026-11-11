import test from 'node:test';
import assert from 'node:assert/strict';
import {numberedSectionRules} from '../src/lib/server/pdf-numbered-sections.ts';
import {guideRulesForIssue} from '../src/lib/work-orders/guide-selection.ts';
const item=(x,y,str,fontName='body')=>({str,fontName,transform:[10,0,0,10,x,y]});
test('numbered sections work across equipment types and keep the source warning',()=>{
 const items=[item(40,700,'Door lock stuck','heading'),item(40,678,'Disconnect power before servicing.'),item(40,658,'1. Inspect the latch for damage.'),item(40,640,'2. Check the wiring connection.'),item(40,620,'Parts diagram','heading'),item(40,600,'3. Replace the entire machine.'),item(340,658,'Replace an unrelated part.')];
 const rules=numberedSectionRules(items,7,612);const found=guideRulesForIssue({source:{verified:true},symptom_rules:rules},'door lock is stuck');
 assert.equal(found.length,1);assert.deepEqual(found[0].source_pages,[7]);assert.deepEqual(found[0].steps,['Door lock stuck — Disconnect power before servicing. — 1. Inspect the latch for damage.','Door lock stuck — Disconnect power before servicing. — 2. Check the wiring connection.']);
});
test('incomplete steps, nonsequential lists and chart branches do not become checks',()=>{
 const base=[item(40,700,'Low Water Pressure','heading'),item(40,678,'1. Inspect the supply.'),item(40,660,'2. Check the filter')];
 assert.deepEqual(numberedSectionRules(base,1,612),[]);
 const nonsequential=[...base.slice(0,2),item(40,660,'3. Check the filter.')];assert.deepEqual(numberedSectionRules(nonsequential,1,612),[]);
 const chart=[...base,item(40,740,'Troubleshooting chart')];assert.deepEqual(numberedSectionRules(chart,1,612),[]);
});

test('instructions under an intervening section heading are not attributed to the prior symptom',()=>{
 const items=[item(40,700,'Door lock stuck','heading'),item(40,676,'Routine maintenance','heading'),item(40,655,'1. Inspect the motor.'),item(40,638,'2. Clean the motor.')];
 assert.deepEqual(numberedSectionRules(items,1,612),[]);
});

test('a newly attached PDF is read through the shared extraction pipeline',async()=>{
 const lines=[['F2',700,'Door lock stuck'],['F1',678,'Disconnect power before servicing.'],['F1',658,'1. Inspect the latch for damage.'],['F1',640,'2. Check the wiring connection.']];
 const stream=lines.map(([font,y,text])=>`BT /${font} 10 Tf 40 ${y} Td (${text}) Tj ET`).join('\n');
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
 let result='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(result));result+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
 const xref=Buffer.byteLength(result);result+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 const {extractPdfTroubleshootingTables}=await import('../src/lib/server/pdf-troubleshooting-tables.ts');
 const rules=await extractPdfTroubleshootingTables(new Uint8Array(Buffer.from(result)));
 const matched=guideRulesForIssue({source:{verified:true},symptom_rules:rules},'door lock is stuck');assert.equal(matched.length,1);assert.equal(matched[0].steps.length,2);assert.deepEqual(matched[0].source_pages,[1]);
});
