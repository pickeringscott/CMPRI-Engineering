import { workOrderReferences } from "./work-order-reference.js";
import { profileHasRole, roleKey } from "./server/roles";
import { staffMentionQuery, staffMentionSuggestions, staffTargetKey, staffTokenInLink, type StaffMention, type StaffMentionRange } from "./staff-note-targets";
export type { StaffMention, StaffMentionRange } from "./staff-note-targets";

export type StaffProfile = { id: string; full_name?: string | null; role: unknown; secondary_roles?: readonly unknown[] };
export const STAFF_ROLE_MENTIONS = [
  ["Chief Engineer", "engineer"], ["Maintenance Technician", "technician"],
  ["General Manager", "manager"], ["Assistant General Manager", "assistant_manager"],
  ["Front Desk Manager", "front_desk_manager"], ["Front Desk", "front_desk"],
  ["Lead Housekeeper", "housekeeping"], ["Housekeeping", "housekeeping"],
  ["System Administrator", "system_admin"], ["Senior Management", "senior_management"],
] as const;
export function staffManagement(profile: Pick<StaffProfile, "role" | "secondary_roles">) {
  return ["engineer", "technician", "manager", "assistant_manager", "front_desk_manager", "system_admin"]
    .some(role => profileHasRole(profile, role as ReturnType<typeof roleKey>));
}
export function staffPhoneEligible(profile: Pick<StaffProfile, "role" | "secondary_roles">) {
  // A Front Desk account never receives Staff Notes phone alerts, including mixed assignments.
  return !profileHasRole(profile, "front_desk") && (staffManagement(profile) || profileHasRole(profile, "housekeeping"));
}
export type StaffDisplayName = {id:string; name:string};
export type StaffLocation = {id:string; name?:string|null; room_number?:string|null; area?:string|null};
export function staffMentionDirectory(profiles: StaffProfile[], names: StaffDisplayName[]=[], locations: StaffLocation[]=[]): StaffMention[] {
  const entries:StaffMention[]=[];
  for(const [label,role] of STAFF_ROLE_MENTIONS)entries.push({id:role,kind:'role',label,userIds:profiles.filter(p=>profileHasRole(p,role)).map(p=>p.id)});
  const people=profiles.filter(p=>!profileHasRole(p,'front_desk')&&p.full_name?.trim());
  for(const profile of people){
    const full=profile.full_name!.trim().replace(/\s+/g,' '),first=full.split(' ')[0];
    entries.push({id:profile.id,kind:'person',label:full,description:full,userIds:[profile.id]});
    if(first!==full&&people.filter(p=>p.full_name?.trim().split(/\s+/)[0].toLocaleLowerCase()===first.toLocaleLowerCase()).length===1)entries.push({id:profile.id,kind:'person',label:first,description:full,userIds:[profile.id]});
  }
  for(const name of names)entries.push({id:name.id,kind:'front_desk_name',label:name.name,userIds:[]});
  for(const location of locations){const label=location.room_number?.trim()||location.name?.trim();if(label)entries.push({id:location.id,kind:'location',label,description:location.room_number?'Room '+location.room_number:location.area||'Location',userIds:[]})}
  return entries.sort((a,b)=>b.label.length-a.label.length||a.label.localeCompare(b.label));
}
/** Author shortcuts use saved identity; a legacy display label must never guess between targets. */
export function staffAuthorMention(note:{author_name:string;author_user_id?:string;author_name_id?:string|null},directory:StaffMention[]){
  const candidates=directory.filter(m=>note.author_name_id?m.kind==='front_desk_name'&&m.id===note.author_name_id:m.kind==='person'&&m.id===note.author_user_id);
  if(candidates.length)return candidates.sort((a,b)=>a.label.length-b.label.length)[0];
  const legacy=directory.filter(m=>m.label===note.author_name);
  return new Set(legacy.map(staffTargetKey)).size===1?legacy[0]:null;
}
export function staffMentionMatches(body: string, directory: StaffMention[]) {
  const matches:Array<{start:number;end:number;mention:StaffMention}>=[];
  for(let at=body.indexOf('@');at>=0;at=body.indexOf('@',at+1)){
    if((at>0&&/[\p{L}\p{N}_]/u.test(body[at-1]))||staffTokenInLink(body,at,at+1))continue;
    const candidates=directory.filter(item=>body.slice(at+1,at+1+item.label.length).toLocaleLowerCase()===item.label.toLocaleLowerCase()&&!/[\p{L}\p{N}_]/u.test(body[at+1+item.label.length]||''));
    const length=Math.max(0,...candidates.map(m=>m.label.length)),longest=candidates.filter(m=>m.label.length===length);
    if(new Set(longest.map(staffTargetKey)).size!==1)continue;
    const mention=longest[0];matches.push({start:at,end:at+1+mention.label.length,mention});at+=mention.label.length;
  }
  return matches;
}
export function resolveStaffMentions(body:string, selected:StaffMentionRange[], directory:StaffMention[]) {
  const result:StaffMentionRange[]=[];
  for(const mention of selected){
    const target=directory.find(m=>staffTargetKey(m)===staffTargetKey(mention)&&m.label.toLocaleLowerCase()===mention.label.toLocaleLowerCase());
    if(!target)throw Error('A selected mention is no longer available. Reselect it before posting.');
    result.push({...mention});
  }
  for(const match of staffMentionMatches(body,directory.filter(m=>m.kind!=='location'&&m.kind!=='work_order')))if(!result.some(m=>match.start<m.end&&match.end>m.start))result.push({start:match.start,end:match.end,id:match.mention.id,kind:match.mention.kind,label:body.slice(match.start+1,match.end)});
  return result.sort((a,b)=>a.start-b.start);
}
export function staffRecipients(body:string,profiles:StaffProfile[],selected?:StaffMentionRange[]) {
  const mentions=selected??staffMentionMatches(body,staffMentionDirectory(profiles)).map(m=>m.mention);
  const ids=new Set(mentions.filter(m=>m.kind==='person').map(m=>m.id));
  const roles=new Set(mentions.filter(m=>m.kind==='role'&&STAFF_ROLE_MENTIONS.some(([,role])=>role===m.id)).map(m=>m.id));
  return profiles.filter(p=>staffManagement(p)||ids.has(p.id)||[...roles].some(role=>profileHasRole(p,role as ReturnType<typeof roleKey>))).map(p=>({user_id:p.id,push:staffPhoneEligible(p)}));
}
export const staffTicketReferences = (body:string)=>workOrderReferences(body).filter(r=>!staffTokenInLink(body,r.start,r.end));
export function staffTicketNumbers(body: string) {
  return [...new Set(staffTicketReferences(body).map(reference => reference.number))];
}

/** Public IDs retain alias identity even when private recipient lists are omitted. */
export function staffMentionCompletion(body:string,caret:number,directory:StaffMention[]) {
  const range=staffMentionQuery(body,caret);if(!range?.query)return null;
  if(directory.some(item=>item.label.toLocaleLowerCase()===range.query.toLocaleLowerCase()))return null;
  const candidates=staffMentionSuggestions(range.query,directory);if(candidates.length!==1)return null;
  const mention=candidates[0];
  // Surname matches appear in the picker; inline ghost text only extends a prefix.
  if(!mention.label.toLocaleLowerCase().startsWith(range.query.toLocaleLowerCase()))return null;
  return {mention,start:range.start+1,typed:range.query,suffix:mention.label.slice(range.query.length)};
}
