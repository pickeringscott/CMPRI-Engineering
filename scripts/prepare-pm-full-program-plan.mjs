/** Local, read-only source reconciliation. Never connects to a database. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {planSourceRoutineChecks} from '../src/lib/pm/source-import-plan.ts';
import {validateRoomHistory} from '../src/lib/pm/history.ts';

const [factsPath,snapshotPath,outputPath]=process.argv.slice(2);
if(!factsPath||!snapshotPath||!outputPath)throw new Error('Usage: facts.json scoped-snapshot.json output-directory');
const facts=JSON.parse(readFileSync(factsPath,'utf8'));
const snapshot=JSON.parse(readFileSync(snapshotPath,'utf8'));
const hotel='c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
if(snapshot.hotel_id!==hotel||!Array.isArray(snapshot.proposals)||!Array.isArray(snapshot.room_history))throw new Error('A complete, hotel-scoped snapshot is required.');
for(const p of snapshot.proposals)if(!p.id||!p.updated_at||!p.revision||p.hotel_id!==hotel)throw new Error('Snapshot lacks identity/revision/property guard.');
const catalog=JSON.parse(readFileSync(new URL('../src/lib/pm/source-catalog.json',import.meta.url),'utf8'));
const routine=planSourceRoutineChecks(facts.facts,snapshot.proposals);
const history=validateRoomHistory({sourceId:facts.source_library_id,sourceName:catalog.workbook,rows:facts.room_history.map(r=>({
 room:r.room,periodStart:`${r.year}-${String((r.quarter-1)*3+1).padStart(2,'0')}-01`,completedOn:r.completed_date,
 sourceReference:`${r.source.sheet}!${r.source.cell}; ${r.completion_evidence}; SHA256 ${facts.xlsx_sha256}`,
}))},catalog.roomNumbers);
const roomAdditions=[],roomExisting=[],roomConflicts=[];
for(const row of history.rows){
 const existing=snapshot.room_history.find(r=>r.room===row.room&&r.period_start===row.periodStart);
 const proposals=snapshot.proposals.filter(p=>p.template_id==='pdf:room-pm-checklist'&&p.period_start===row.periodStart&&p.scope_key===`room:${row.room}`&&p.status!=='rejected');
 if(existing){
  if(existing.completed_on===row.completedOn)roomExisting.push(row);
  else roomConflicts.push({row,existing,reason:'Keep existing date and answers; conflicting workbook date requires reconciliation.'});
 }else if(proposals.length)roomConflicts.push({row,recordIds:proposals.map(p=>p.id),reason:'Existing room proposal must be reconciled before adding historical completion.'});
 else roomAdditions.push(row);
}
const grouped=new Map();
for(const check of routine.additions){
 const key=[check.template_id,check.period_start,check.scope_key].join('|');
 const record=grouped.get(key)||{template_id:check.template_id,period_start:check.period_start,scope_key:check.scope_key,
  payload:{responses:{},form_data:{},notes:'Corporate source checkbox evidence. No inspection condition or exact completion date inferred.',is_complete:false,completed_on:null,source_cells:[]}};
 record.payload.responses[check.item_id]=true;
 record.payload.source_cells.push({...check.source,item_id:check.item_id});
 grouped.set(key,record);
}
const result={status:'LOCAL REVIEW PLAN — NOT EXECUTED',hotel_id:hotel,source_sha256:facts.xlsx_sha256,
 expected_snapshot_sha256:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
 source_counts:{routine_positive:facts.facts.filter(x=>x.checked).length,room_facts:history.rows.length},
 routine_records:[...grouped.values()],already_recorded:routine.alreadyRecorded,conflicts:routine.conflicts,
 room_import:{...history,rows:roomAdditions},room_already_recorded:roomExisting,room_conflicts:roomConflicts,
 unresolved_source:facts.unresolved,
 canRelease:!routine.conflicts.length&&!roomConflicts.length&&!facts.unresolved.length,
 release_requirements:['Refresh and compare the full scoped snapshot inside the application transaction.',
 'Do not apply any subset while a required reconciliation remains unresolved.',
 'Production application and deployment require exact release approval.'],expected_snapshot:snapshot};
// These dispositions implement the explicit preservation requirement; they do
// not resolve malformed dates, approve pending edits, or import excluded cells.
result.retained_evidence=[];
for(const field of ['conflicts','room_conflicts','unresolved_source'])for(const issue of result[field]) {
 const allowed=field==='unresolved_source'
  || (field==='conflicts'&&issue.reason==='A pending review owns this task; do not silently approve or supersede it.')
  || (field==='room_conflicts'&&issue.row.room==='231'&&issue.row.periodStart==='2026-01-01'&&issue.existing?.completed_on==='2026-01-06');
 if(allowed)result.retained_evidence.push({field,sha256:createHash('sha256').update(JSON.stringify(issue)).digest('hex'),action:'preserve_without_import',reason:field==='conflicts'?'Existing pending review remains pending.':field==='room_conflicts'?'Explicit instruction: preserve Room 231 January 6.':'Source exception retained; no fabricated date or selection.'});
}
// Completion reconciliation and outcome verification must still be attached.
result.canRelease=false;
mkdirSync(outputPath,{recursive:true});
writeFileSync(resolve(outputPath,'full-program-plan.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({routineRecords:grouped.size,sourceChecks:result.source_counts.routine_positive,
 roomAdditions:roomAdditions.length,roomExisting:roomExisting.length,conflicts:routine.conflicts.length+roomConflicts.length,unresolved:facts.unresolved.length,canRelease:result.canRelease}));
