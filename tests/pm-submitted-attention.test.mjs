import test from 'node:test';
import assert from 'node:assert/strict';
import {pmSubmittedIssueLinks,pmIssueExternalId,pmTicketClosed} from '../src/lib/pm/issues.ts';
const context=['workbook:monthly:test','2026-11-01','property'];
const link=(key,status='Open')=>({id:key,import_external_id:pmIssueExternalId(...context,key),status});
test('draft, dismissed and failed submissions have no submitted state without a persisted ticket',()=>{
 assert.deepEqual(pmSubmittedIssueLinks([],...context,'item:a'),[]);
});
test('partial success locks only the successful item and retry preserves its identity',()=>{
 const first=link('item:a');
 assert.deepEqual(pmSubmittedIssueLinks([first],...context,'item:a'),[first]);
 assert.deepEqual(pmSubmittedIssueLinks([first],...context,'item:b'),[]);
 assert.equal(pmSubmittedIssueLinks([first,link('item:b')],...context).length,2);
 assert.equal(pmSubmittedIssueLinks([first],context[0],'2026-12-01',context[2]).length,0);
});
test('repair status cannot reset submitted state; only exact Closed gets the notice',()=>{
 for(const status of ['Open','In Progress','Completed','Closed','closed','Cancelled']){
  const ticket=link('item:a',status);
  assert.equal(pmSubmittedIssueLinks([ticket],...context,'item:a').length,1);
  assert.equal(pmTicketClosed(ticket),status==='Closed');
 }
 assert.equal(pmTicketClosed(undefined),false);
});
