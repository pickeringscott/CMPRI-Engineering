import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pmIssueCandidates, pmIssueExternalId, validatePmIssueMetadata } from '../src/lib/pm/issues.ts';
const catalog=JSON.parse(fs.readFileSync('src/lib/pm/recorded-definitions.json','utf8'));
const noFailures = new Set(['functional','passed','clearAccess','locked','allEmployeesAccountedFor']);

for (const template of catalog) test(`${template.id}: issue boundaries and explicit field reporting`, () => {
  assert.deepEqual(pmIssueCandidates(template, {}), []);
  for (const item of template.checklist) {
    for (const value of ['', false, true, 'complete', 'na']) assert.equal(pmIssueCandidates(template,{responses:{[item.id]:value}}).length,0,`${item.id}: ${value}`);
    const issue=pmIssueCandidates(template,{responses:{[item.id]:'follow-up'}});
    assert.equal(issue.length,1); assert.equal(issue[0].key,`item:${item.id}`);
    assert.equal(issue[0].detail,'');
  }
  for (const field of template.fields) {
    const key=`field:${field.id}`;
    assert.equal(pmIssueCandidates(template,{form_data:{[field.id]:'No'}}).length,noFailures.has(field.id)?1:0);
    assert.equal(pmIssueCandidates(template,{form_data:{pmIssueDetails:{[key]:{flagged:true,detail:'Fictional defect',locationId:'local-location'}}}})[0].detail,'Fictional defect');
  }
  for (const field of template.repeatableFields||[]) {
    const key=`row:stable-row:${field.id}`;
    const data={logEntries:[{_pmRowId:'stable-row',location:'Fictional fixture',[field.id]:'No'}]};
    assert.equal(pmIssueCandidates(template,{form_data:data}).length,noFailures.has(field.id)?1:0);
    data.pmIssueDetails={[key]:{flagged:true,detail:'Fictional row issue'}};
    assert.equal(pmIssueCandidates(template,{form_data:data}).find(x=>x.key===key)?.detail,'Fictional row issue');
  }
});
test('repeatable row reorder preserves identity; removed rows do not issue new orders',()=>{
 const t=catalog.find(t=>t.repeatableFields?.some(f=>f.id==='functional'));
 const rows=[{_pmRowId:'one',functional:'No'},{_pmRowId:'two',functional:'No'}];
 const keys=rows=>pmIssueCandidates(t,{form_data:{logEntries:rows}}).map(i=>i.key).sort();
 assert.deepEqual(keys(rows),keys([...rows].reverse()));
 assert.deepEqual(keys(rows.slice(1)),['row:two:functional']);
});
test('idempotency identity separates periods, scope and items; does not change on description correction',()=>{
 const key=pmIssueExternalId('pdf:test','2026-11-01','room:101','item:one');
 assert.equal(key,pmIssueExternalId('pdf:test','2026-11-01','room:101','item:one'));
 for(const args of [['pdf:test','2026-12-01','room:101','item:one'],['pdf:test','2026-11-01','room:102','item:one'],['pdf:test','2026-11-01','room:101','item:two']])assert.notEqual(key,pmIssueExternalId(...args));
});
test('invalid issue metadata and duplicate row identities are rejected',()=>{
 assert.ok(validatePmIssueMetadata({pmIssueDetails:[]}));
 assert.ok(validatePmIssueMetadata({pmIssueDetails:{x:{detail:123}}}));
 assert.ok(validatePmIssueMetadata({logEntries:[{_pmRowId:'one'},{_pmRowId:'one'}]}));
 assert.equal(validatePmIssueMetadata({logEntries:[{_pmRowId:'one'},{_pmRowId:'two'}]}),null);
});
