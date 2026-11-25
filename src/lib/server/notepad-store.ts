import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { fetchAllPages } from './paginated-query';
import { profileHasRole } from './roles';
import { NOTEPAD_ROLES, NOTEPAD_TEST_EMAILS, notepadCanRead, type NotepadNote, type NotepadPerson, type NotepadDocument, type NotepadReply, type NotepadAttachment } from '../notepad';
import type { NoteDocument } from '../general-notes';
import { inlineLegacy, legacyGeneralNote } from '../notepad-legacy';
import { STAFF_FILE_BUCKET, staffInlineMedia } from '../staff-note-media';
import { accountRoleDisplayName, isMaintenanceChiefDisplay } from '../account-display';

export type NotepadRow = { hotel_id: string; id: string; author_user_id: string; author_name: string | null; document: NotepadDocument | null; revision: number; change_id: string; created_at: string; updated_at: string; deleted_at: string | null; legacy_source: 'general' | 'staff' | null };
type Profile = { id: string; full_name: string | null; role: string; secondary_roles: string[]; email: string | null; active: boolean };
type StaffRow = { id: string; author_user_id: string; author_name: string; body: string; parent_id: string | null; created_at: string; notepad_revision?: number; attachments: Array<{ id: string; name: string; type: string; size: number }>; gif_ids: string[]; mentions?: Array<{ id: string; kind: string; label: string; start: number; end: number }> };
export const NOTEPAD_COLUMNS = 'hotel_id,id,author_user_id,author_name,document,revision,change_id,created_at,updated_at,deleted_at,legacy_source';
const emptyDocument = (): NotepadDocument => ({ title:'Untitled',audience:{all:false,roles:[],people:[]},content:'',priority:'Normal',fontSize:16,fontFamily:'Comic Sans MS',titleFontFamily:'Comic Sans MS',ink:[],itemThreads:{},attachments:[] });
export function projectNotepadRow(row: NotepadRow): NotepadNote | null {
  if (!row.document || row.deleted_at) return null;
  return { ...row.document,id:row.id,authorId:row.author_user_id,...(row.author_name ? {authorName:row.author_name} : {}),createdAt:row.created_at,updatedAt:row.updated_at,revision:Number(row.revision),...(row.legacy_source ? {legacySource:row.legacy_source} : {}) };
}
export function legacyStaffNotes(rows: StaffRow[]) {
  const byId=new Map(rows.map(row=>[row.id,row])),aliases:Record<string,string>={},children=new Map<string,StaffRow[]>();
  for(const row of rows)if(row.parent_id){const list=children.get(row.parent_id)||[];list.push(row);children.set(row.parent_id,list)}
  for(const row of rows){let current=row;const seen=new Set<string>();while(current.parent_id&&byId.has(current.parent_id)&&!seen.has(current.id)){seen.add(current.id);current=byId.get(current.parent_id)!}aliases[row.id]=current.id}
  const files=(row:StaffRow):NotepadAttachment[]=>[...(row.attachments||[]).map(a=>({...a,kind:'file' as const})),...(row.gif_ids||[]).map(gifId=>({id:'gif:'+gifId,kind:'gif' as const,gifId,name:'GIPHY GIF'}))];
  const notes=rows.filter(row=>!row.parent_id||!byId.has(row.parent_id)).map(row=>{
    const item='legacy-staff-'+row.id,attachments=files(row),seen=new Set([row.id]);
    const legacyVersion='staff:'+createHash('sha256').update(rows.filter(member=>aliases[member.id]===row.id).sort((a,b)=>a.id.localeCompare(b.id)).map(member=>member.id+':'+String(member.notepad_revision||0)).join('\n')).digest('hex');
    const replies=(parent:string,depth=0):NotepadReply[] => depth>50?[]:(children.get(parent)||[]).filter(r=>!seen.has(r.id)).sort((a,b)=>a.created_at.localeCompare(b.created_at)).map(r=>{seen.add(r.id);attachments.push(...files(r));return{id:r.id,authorId:r.author_user_id,authorName:r.author_name,at:r.created_at,text:r.body||'(Attachment)',replies:replies(r.id,depth+1)}});
    const thread=replies(row.id),title=row.body.split('\n').find(line=>line.trim())?.trim().slice(0,120)||'Staff note';
    // The editor removes threads from empty items. Attachment-only legacy posts
    // need a stable, nonempty anchor so opening them cannot discard their replies.
    return {...emptyDocument(),id:row.id,title,audience:{all:true,roles:[],people:[]},authorId:row.author_user_id,authorName:row.author_name,createdAt:row.created_at,updatedAt:row.created_at,revision:0,legacySource:'staff' as const,legacyVersion,content:'<p data-item-id="'+item+'">'+inlineLegacy(row.body.trim()?row.body:'(Attachment)',0,{mentions:row.mentions as NoteDocument['mentions']}) .replace(/\n/g,'<br>')+'</p>',itemThreads:{[item]:thread},attachments:[...new Map(attachments.map(file=>[file.id,file])).values()]};
  });
  return {notes,aliases};
}
export async function notepadDirectory(admin: SupabaseClient,hotelId: string) {
  const members=await fetchAllPages<{user_id:string;active:boolean}>((from,to)=>admin.from('hotel_members').select('user_id,active').eq('hotel_id',hotelId).order('user_id').range(from,to));
  if(members.error)throw Error('Notepad recipients could not be loaded.');
  const profiles:Profile[]=[];
  for(let at=0;at<(members.data||[]).length;at+=200){const result=await admin.from('profiles').select('id,full_name,role,secondary_roles,email,active').in('id',members.data!.slice(at,at+200).map(m=>m.user_id));if(result.error)throw Error('Notepad recipients could not be loaded.');profiles.push(...(result.data||[]) as Profile[])}
  return profiles.map(p=>{
    const name=p.full_name?.trim()||p.role||'Staff',parts=name.split(/\s+/);
    const active=p.active===true&&members.data!.some(m=>m.user_id===p.id&&m.active);
    const taggable=active&&!NOTEPAD_TEST_EMAILS.has((p.email||'').trim().toLowerCase());
    // Keep the duplicate administrative identity for existing authors, tags and
    // role access. Omit it from new person tags and individual recipient choices.
    const duplicateAdmin=name.replace(/\s+/g,' ').toLowerCase()==='scott pickering'&&profileHasRole(p,'system_admin')&&!isMaintenanceChiefDisplay(p);
    return{id:p.id,name,short:parts[0],initials:parts.map(part=>part[0]).slice(0,2).join('').toUpperCase(),role:p.role,displayRole:accountRoleDisplayName(p),roles:NOTEPAD_ROLES.filter(r=>profileHasRole(p,r.id)).map(r=>r.id),active,taggable,recipientSelectable:taggable&&!duplicateAdmin} satisfies NotepadPerson;
  }).sort((a,b)=>a.name.localeCompare(b.name));
}
export async function loadNotepad(admin:SupabaseClient,hotelId:string,userId:string,media=true) {
  const [people,overrides,personal,staff,order]=await Promise.all([
    notepadDirectory(admin,hotelId),
    fetchAllPages<NotepadRow>((from,to)=>admin.from('cmpri_notepad_notes').select(NOTEPAD_COLUMNS).eq('hotel_id',hotelId).order('id').range(from,to)),
    fetchAllPages<{id:string;user_id:string;document:NoteDocument;updated_at:string;revision:number}>((from,to)=>admin.from('cmpri_general_notes').select('id,user_id,document,updated_at,revision').eq('hotel_id',hotelId).eq('user_id',userId).is('deleted_at',null).order('id').range(from,to)),
    fetchAllPages<StaffRow>((from,to)=>admin.from('cmpri_staff_notes').select('id,author_user_id,author_name,body,parent_id,created_at,notepad_revision,attachments,gif_ids,mentions').eq('hotel_id',hotelId).order('id').range(from,to)),
    admin.from('cmpri_notepad_order').select('note_ids').eq('hotel_id',hotelId).eq('user_id',userId).maybeSingle(),
  ]);
  if(overrides.error||order.error)throw Error('Notepad storage is not available yet.');
  if(personal.error||staff.error)throw Error('Existing notes could not be loaded.');
  const actor=people.find(p=>p.id===userId);if(!actor?.active)throw Error('An active property account is required.');
  const legacy=legacyStaffNotes(staff.data||[]),replaced=new Set((overrides.data||[]).map(row=>row.id));
  const notes:NotepadNote[]=[...(overrides.data||[]).map(projectNotepadRow).filter((n):n is NotepadNote=>!!n&&notepadCanRead(n,actor)),...(personal.data||[]).filter(row=>!replaced.has(row.id)).map(row=>({...legacyGeneralNote(row.id,row.user_id,row.document,row.updated_at),legacyRevision:Number(row.revision),legacyVersion:'general:'+String(row.revision)})),...legacy.notes.filter(n=>!replaced.has(n.id))].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  if(media)await signNotepadAttachments(admin,hotelId,notes,legacy.aliases);
  return {hotelId,userId,people,roles:NOTEPAD_ROLES.map(r=>({...r})),notes,order:(order.data?.note_ids||[]) as string[],legacyAliases:legacy.aliases,rows:overrides.data||[]};
}
export function notepadAttachmentURL(url:string,type:string,name:string) {
  return type==='application/pdf'||staffInlineMedia(type)?url:url+'&download='+encodeURIComponent(name);
}

export async function signNotepadAttachments(admin:SupabaseClient,hotelId:string,notes:NotepadNote[],aliases:Record<string,string>) {
  const ids=[...new Set(notes.flatMap(n=>n.attachments.filter(a=>a.kind==='file').map(a=>a.id)))];if(!ids.length)return;
  const files:Array<{id:string;note_id:string|null;storage_path:string;name:string;media_type:string;legacy:boolean}>=[];
  for(let at=0;at<ids.length;at+=200){const [own,legacy]=await Promise.all([
    admin.from('cmpri_notepad_uploads').select('id,note_id,storage_path,name,media_type').eq('hotel_id',hotelId).eq('ready',true).in('id',ids.slice(at,at+200)),
    admin.from('cmpri_staff_note_uploads').select('id,note_id,storage_path,name,media_type').eq('hotel_id',hotelId).eq('ready',true).in('id',ids.slice(at,at+200)),
  ]);if(own.error||legacy.error)throw Error('Attachments could not be loaded.');files.push(...(own.data||[]).map(row=>({...row,legacy:false})),...(legacy.data||[]).map(row=>({...row,legacy:true})));}
  const approved=files.filter(file=>notes.some(note=>note.attachments.some(a=>a.id===file.id)&&file.note_id&&(file.legacy?aliases[file.note_id]===note.id:file.note_id===note.id)));
  for(let at=0;at<approved.length;at+=200){const batch=approved.slice(at,at+200),signed=await admin.storage.from(STAFF_FILE_BUCKET).createSignedUrls(batch.map(file=>file.storage_path),3600);if(signed.error)throw Error('Attachments could not be opened.');
    for(const file of batch){const url=signed.data?.find(s=>s.path===file.storage_path)?.signedUrl;if(url)for(const note of notes){if(file.note_id&&(file.legacy?aliases[file.note_id]:file.note_id)!==note.id)continue;const a=note.attachments.find(a=>a.kind==='file'&&a.id===file.id);if(a)a.url=notepadAttachmentURL(url,file.media_type,file.name)}}
  }
}

/** Server-only original-file lookup. Never accept a caller-supplied bucket, URL, or storage path. */
export async function resolveNotepadAttachment(admin:SupabaseClient,hotelId:string,userId:string,noteId:string,uploadId:string) {
  const state=await loadNotepad(admin,hotelId,userId,false),id=state.legacyAliases[noteId]||noteId;
  const note=state.notes.find(n=>n.id===id);if(!note?.attachments.some(a=>a.kind==='file'&&a.id===uploadId))return null;
  const own=await admin.from('cmpri_notepad_uploads').select('id,note_id,storage_path,name,media_type,size_bytes').eq('hotel_id',hotelId).eq('id',uploadId).eq('ready',true).maybeSingle();
  if(own.error)throw Error('Attachment could not be verified.');
  let file=own.data?.note_id===id?own.data:null;
  if(!file){const legacy=await admin.from('cmpri_staff_note_uploads').select('id,note_id,storage_path,name,media_type,size_bytes').eq('hotel_id',hotelId).eq('id',uploadId).eq('ready',true).maybeSingle();if(legacy.error)throw Error('Attachment could not be verified.');file=legacy.data;if(!file||state.legacyAliases[file.note_id]!==id)return null}
  return {id:file.id,name:file.name,type:file.media_type,size:Number(file.size_bytes),path:file.storage_path,bucket:STAFF_FILE_BUCKET};
}
