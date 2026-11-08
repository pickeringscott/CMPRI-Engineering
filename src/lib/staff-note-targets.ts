import {plainTextParts} from "./plain-text-links";
import { workOrderReferences, workOrderNumber } from "./work-order-reference.js";
/** Staff Notes target identity is separate from its visible, editable text. */
export type StaffTargetKind = 'person' | 'role' | 'front_desk_name' | 'location' | 'work_order';
export type StaffMention = { id: string; kind: StaffTargetKind; label: string; description?: string; userIds: string[] };
export type StaffMentionRange = Pick<StaffMention, 'id' | 'kind' | 'label'> & { start: number; end: number };
export const staffTokenInLink=(body:string,start:number,end:number)=>plainTextParts(body).some(p=>p.href&&p.start<end&&p.end>start);
function targetTextMatches(body:string,mention:StaffMentionRange){
  if(staffTokenInLink(body,mention.start,mention.end))return false;
  return mention.kind==='work_order'?workOrderReferences(body).some(r=>r.start===mention.start&&r.end===mention.end&&r.number===workOrderNumber(mention.label)):body.slice(mention.start,mention.end)==='@'+mention.label;
}
export const staffTargetKey = (target: Pick<StaffMention, 'id' | 'kind'>) => `${target.kind}:${target.id}`;
export const staffTargetType = (kind: StaffTargetKind) => ({ person:'Person', role:'Role', front_desk_name:'Front Desk name', location:'Location', work_order:'Work order' })[kind];
export function staffMentionQuery(body: string, caret: number) {
  const match=body.slice(0,caret).match(/(?:^|[^\p{L}\p{N}_])@([^@\n]*)$/u);
  if(!match||/https?:\/\/\S*$/i.test(body.slice(0,caret)))return null;
  return {start:caret-match[1].length-1,end:caret,query:match[1]};
}
export function staffMentionSuggestions(query: string, directory: StaffMention[]) {
  const prefix=query.toLocaleLowerCase();
  const rank=(m:StaffMention)=>m.label.toLocaleLowerCase().startsWith(prefix)?0:
    (m.kind==='person'||m.kind==='front_desk_name')&&m.label.trim().split(/\s+/).length>1&&m.label.trim().split(/\s+/).at(-1)!.toLocaleLowerCase().startsWith(prefix)?1:2;
  const candidates=directory.filter(m=>rank(m)<2);
  const unique=new Map<string,StaffMention>();
  for(const candidate of candidates){const key=staffTargetKey(candidate),prior=unique.get(key);if(!prior||rank(candidate)<rank(prior)||(rank(candidate)===rank(prior)&&candidate.label.length<prior.label.length))unique.set(key,candidate)}
  return [...unique.values()].sort((a,b)=>rank(a)-rank(b)||a.label.localeCompare(b.label)||a.kind.localeCompare(b.kind));
}
export function rebaseStaffMentions(before: string, after: string, mentions: StaffMentionRange[]) {
  if(before===after)return mentions;
  let start=0,suffix=0;
  while(start<before.length&&start<after.length&&before[start]===after[start])start++;
  while(suffix<before.length-start&&suffix<after.length-start&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
  const end=before.length-suffix,delta=after.length-before.length;
  return mentions.flatMap(mention=>{
    let value=mention;
    if(end<=mention.start)value={...mention,start:mention.start+delta,end:mention.end+delta};
    else if(start<mention.end)return [];
    if(!targetTextMatches(after,value)||/[\p{L}\p{N}_]/u.test(after[value.start-1]||'')||/[\p{L}\p{N}_]/u.test(after[value.end]||''))return [];
    return [value];
  });
}
export function insertStaffMention(body: string, range: {start:number;end:number}, mention: StaffMention, selected: StaffMentionRange[]) {
  const value=body.slice(0,range.start)+'@'+mention.label+' '+body.slice(range.end),end=range.start+mention.label.length+1;
  const mentions=rebaseStaffMentions(body,value,selected).filter(m=>m.end<=range.start||m.start>=end);
  mentions.push({start:range.start,end,id:mention.id,kind:mention.kind,label:mention.label});
  return {value,caret:end+1,mentions:mentions.sort((a,b)=>a.start-b.start)};
}
export function selectedStaffMentions(body: string, value: unknown): StaffMentionRange[] | null {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>100)return null;
  const output:StaffMentionRange[]=[];
  for(const item of value){
    if(!item||typeof item!=='object'||!['person','role','front_desk_name','location','work_order'].includes(item.kind)||typeof item.id!=='string'||!item.id||typeof item.label!=='string'||item.label.length>255||!Number.isSafeInteger(item.start)||!Number.isSafeInteger(item.end)||item.start<0||item.end>body.length||item.end<=item.start||!targetTextMatches(body,item)||/[\p{L}\p{N}_]/u.test(body[item.start-1]||'')||/[\p{L}\p{N}_]/u.test(body[item.end]||''))return null;
    output.push({id:item.id,kind:item.kind,label:item.label,start:item.start,end:item.end});
  }
  output.sort((a,b)=>a.start-b.start);
  if(output.some((m,i)=>i>0&&m.start<output[i-1].end))return null;
  return output;
}
/** Reuse the established explicit reference forms, including #number and WO#number. */
export function staffReferenceQuery(body:string,caret:number){
  const reference=workOrderReferences(body.slice(0,caret)).at(-1);
  return reference?.end===caret&&!staffTokenInLink(body,reference.start,reference.end)?reference:null;
}
export function insertStaffReference(body:string,range:{start:number;end:number},mention:StaffMention,selected:StaffMentionRange[]){
  const text=body.slice(range.start,range.end),value=body.slice(0,range.end)+' '+body.slice(range.end);
  const mentions=rebaseStaffMentions(body,value,selected).filter(m=>m.end<=range.start||m.start>=range.end);
  mentions.push({start:range.start,end:range.end,id:mention.id,kind:'work_order',label:mention.label});
  return {value,caret:range.start+text.length+1,mentions:mentions.sort((a,b)=>a.start-b.start)};
}
