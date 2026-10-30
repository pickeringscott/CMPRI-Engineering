/** Read-only local reconciliation; never resets a completion or connects to production. */
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const dir=resolve(process.argv[2]||'../pm-corporate-review');
const snapshot=JSON.parse(readFileSync(resolve(dir,'scoped-snapshot-20261030.json'),'utf8'));
const facts=JSON.parse(readFileSync(resolve(dir,'verified-cell-facts.json'),'utf8'));
const inspections=snapshot.proposals.filter(p=>p.template_id.startsWith('pdf:'));
const links=[];
for(const record of snapshot.proposals){
 for(const link of record.payload.historical_completion_links||[]){
  const inspection=inspections.find(p=>p.id===link.inspection_id);
  const source=facts.facts.filter(f=>f.checked&&f.template_id===record.template_id&&f.period_start===record.period_start&&f.scope_key===record.scope_key&&f.item_id===link.item_id);
  const other=snapshot.proposals.filter(p=>p.id!==record.id&&p.status==='approved'&&p.template_id===record.template_id&&p.period_start===record.period_start&&p.scope_key===record.scope_key&&Object.hasOwn(p.payload.responses||{},link.item_id));
  links.push({record_id:record.id,item_id:link.item_id,template_id:record.template_id,period_start:record.period_start,
   inspection_id:link.inspection_id,inspection_present:!!inspection,stored_checked:record.payload.responses?.[link.item_id],
   direct_workbook_evidence:source.map(f=>f.source),other_approved_records:other.map(p=>({id:p.id,response:p.payload.responses[link.item_id]})),
   disposition:source.length?'Retain checkbox: independent recorded workbook evidence.':other.length?'Preserve other approved response; chronology must be reconciled.':'Review complete inspection evidence; neither any answer nor source absence proves completion or incompletion.',
   proposed_write:null});
 }
}
const result={status:'READ-ONLY LOCAL PROVENANCE RECONCILIATION',inspection_records:inspections.length,
 legacy_complete_flags:inspections.filter(p=>p.payload.historical_source_import&&p.payload.is_complete===true).map(p=>p.id),
 linked_checks:links.length,independently_supported:links.filter(l=>l.direct_workbook_evidence.length).length,
 requires_inspection_review:links.filter(l=>!l.direct_workbook_evidence.length&&!l.other_approved_records.length).length,
 links,warning:'No reset authorized by this report. Missing workbook check is not evidence an inspection was not performed. No production action executed.'};
const reviewed=JSON.parse(readFileSync(resolve(dir,'completion-source-review.json'),'utf8'));
if(reviewed.length!==52||new Set(reviewed.map(r=>r.id)).size!==52)throw new Error('Complete reviewed source coverage required');
const complete=new Set(['all_applicable_source_tasks_recorded','all_recorded_log_rows_answered']);
result.reviewed_inspections=reviewed;
result.inspection_classifications={};
for(const row of reviewed)result.inspection_classifications[row.classification]=(result.inspection_classifications[row.classification]||0)+1;
for(const link of links){
 const row=reviewed.find(r=>r.id===link.inspection_id);if(!row)throw new Error('Missing source review');
 link.source_review=row;
 if(!link.direct_workbook_evidence.length){
  link.disposition=complete.has(row.classification)
   ? 'Source inspection recorded; retain completion, including recorded failures. This does not certify equipment passed.'
   : 'Preserve stored history; display completion unverified. Do not fabricate unanswered conditions.';
 }
}
result.required_decision={action:'No invented answer required. Preserve unresolved source conditions and display unverified completion.',
 impact:'Source blanks remain blank; only independently supported completions count.',
 items:links.filter(l=>!l.direct_workbook_evidence.length&&!complete.has(l.source_review.classification))};
result.requires_inspection_review=0;
result.unverified_derived_checks=result.required_decision.items.length;
writeFileSync(resolve(dir,'completion-provenance-reconciliation.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({linked_checks:result.linked_checks,independently_supported:result.independently_supported,requires_inspection_review:result.requires_inspection_review,legacy_complete_flags:result.legacy_complete_flags.length}));
