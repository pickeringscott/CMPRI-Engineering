type Entry = {responses?:Record<string,unknown>;form_data?:Record<string,unknown>;notes?:string;deficiency_notes?:string;completed_on?:string|null};
type History = {item_answers?:Record<string,{value:string}>};
/** One hydration path for the real editable PM form. Existing user responses win. */
export function pmEntryForm(entry?:Entry,history?:History){
 const recorded=Object.fromEntries(Object.entries(history?.item_answers||{}).map(([id,answer])=>[id,answer.value]));
 return {
  checklist:{...recorded,...Object.fromEntries(Object.entries(entry?.responses||{}).filter(([,value])=>typeof value==='string'))} as Record<string,string>,
  formData:Object.fromEntries(Object.entries(entry?.form_data||{}).filter(([key])=>key!=='logEntries' && key!=='pmIssueDetails').map(([key,value])=>[key,String(value??'')])),
  logEntries:Array.isArray(entry?.form_data?.logEntries)?entry.form_data.logEntries.map(row=>row&&typeof row==='object'?Object.fromEntries(Object.entries(row).map(([key,value])=>[key,String(value??'')])):{}):null,
  notes:entry?.notes||'',deficiencyNotes:entry?.deficiency_notes||'',completedOn:entry?.completed_on||'',
 };
}
