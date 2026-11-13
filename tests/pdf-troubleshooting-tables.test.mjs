import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfTroubleshootingTables } from '../src/lib/server/pdf-troubleshooting-tables.ts';
import { guideRulesForIssue } from '../src/lib/work-orders/guide-selection.ts';

function pdf() {
  const items = [
    [90,720,'PROBLEM'],[280,720,'CAUSE'],[455,720,'SOLUTION'],
    [40,700,'Valve leaks when shut off.'],[220,700,'Washers worn.'],[405,700,'Replace washers using'],[405,686,'the repair kit.'],
    [40,660,'Valve will not pass water.'],[220,660,'Supply closed.'],[405,660,'Turn on both supplies.'],
  ];
  const stream = items.map(([x,y,text])=>`BT /F1 10 Tf ${x} ${y} Td (${text}) Tj ET`).join('\n');
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let result='%PDF-1.4\n'; const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(result));result+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(result);result+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
  result+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return new Uint8Array(Buffer.from(result));
}

test('positioned problem and solution columns retain source condition when everyday language matches', async () => {
  const rules=await extractPdfTroubleshootingTables(pdf());
  assert.equal(guideRulesForIssue({source:{verified:true},symptom_rules:rules},'shower leaking').length,0);
  const matches=guideRulesForIssue({source:{verified:true},symptom_rules:rules},'Valve leaks when shut off.');
  assert.equal(matches.length,1);
  assert.deepEqual(matches[0].source_pages,[1]);
  assert.deepEqual(matches[0].steps,['Valve leaks when shut off. — Possible cause: Washers worn. — Replace washers using the repair kit.']);
  assert.ok(!matches[0].steps[0].includes('Turn on both supplies'));
});
