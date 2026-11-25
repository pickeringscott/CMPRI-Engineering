import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { NOTEPAD_UUID, notepadAudienceWithPeople, notepadDocument, type NotepadDocument } from '@/lib/notepad';
import { notepadPersonTagCounts, validateNotepadDocument } from '@/lib/server/notepad-document';
import { loadNotepad, projectNotepadRow, signNotepadAttachments, type NotepadRow } from '@/lib/server/notepad-store';
import { resolveProfileTimeFormat } from '@/lib/profile-preferences';

const headers = { 'Cache-Control':'private, no-store' };
const response = (body: unknown,status=200) => NextResponse.json(body,{status,headers});
async function principal(request:NextRequest) { const auth=await requireUser(request),property=request.headers.get('x-cmpri-property'); return auth&&(!property||property===auth.principal.hotelId)?auth:null; }
async function readBody(request:NextRequest) {
  const reader=request.body?.getReader();if(!reader)return null;
  let count=0,text='';const decoder=new TextDecoder();
  try { for(;;){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>2097152){await reader.cancel();throw Error('BODY_TOO_LARGE')}text+=decoder.decode(value,{stream:true})} return JSON.parse(text+decoder.decode()); } finally { reader.releaseLock(); }
}
const sameAudience = (a:NotepadDocument['audience'],b:NotepadDocument['audience']) => a.all===b.all&&JSON.stringify([...a.roles].sort())===JSON.stringify([...b.roles].sort())&&JSON.stringify([...a.people].sort())===JSON.stringify([...b.people].sort());
export async function GET(request:NextRequest) {
  const auth=await principal(request);if(!auth)return response({error:'Sign in is required.'},401);
  const id=request.nextUrl.searchParams.get('id');if(id&&!NOTEPAD_UUID.test(id))return response({error:'Invalid note.'},400);
  try {
    const { hotelId: property, identity, profile } = auth.principal;
    const [notepad, preferences] = await Promise.all([
      loadNotepad(auth.admin,property,identity.id),
      auth.admin.from('profiles').select('preferences').eq('id',identity.id).maybeSingle(),
    ]);
    const {hotelId,userId,people,roles,notes,order,legacyAliases}=notepad;
    const timeFormat = resolveProfileTimeFormat(preferences.data?.preferences,profile);
    const state={hotelId,userId,people,roles,notes,order,legacyAliases,timeFormat};
    if(id){const note=state.notes.find(n=>n.id===(state.legacyAliases[id]||id));if(!note)return response({error:'This note is unavailable.'},404);return response({...state,note})}
    return response(state);
  } catch(error) { return response({error:error instanceof Error?error.message:'Notepad could not be loaded.',code:'NOTEPAD_NOT_READY'},503); }
}
export async function PUT(request:NextRequest) {
  const auth=await principal(request);if(!auth)return response({error:'Sign in is required.'},401);
  let input;try{input=await readBody(request)}catch(error){return response({error:error instanceof Error&&error.message==='BODY_TOO_LARGE'?'This note is too large to sync.':'Supply a valid note.'},error instanceof Error&&error.message==='BODY_TOO_LARGE'?413:400)}
  if(!input||Array.isArray(input)||Object.keys(input).some(key=>!['id','expectedRevision','expectedLegacyVersion','changeId','document'].includes(key))||!NOTEPAD_UUID.test(input.id||'')||!NOTEPAD_UUID.test(input.changeId||'')||!(input.expectedRevision===null||(Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0))||(input.expectedLegacyVersion!=null&&(typeof input.expectedLegacyVersion!=='string'||!/^(general:\d+|staff:[0-9a-f]{64})$/.test(input.expectedLegacyVersion)))||input.document===undefined)return response({error:'Supply the note, loaded revision, and mutation ID.'},400);
  const hotel=auth.principal.hotelId,actor=auth.principal.identity.id;
  try {
    const state=await loadNotepad(auth.admin,hotel,actor,false),previous=state.notes.find(n=>n.id===input.id),stored=state.rows.find(n=>n.id===input.id);
    if(stored&&!previous){if(stored.deleted_at&&stored.author_user_id===actor&&stored.change_id===input.changeId&&input.document===null)return response({id:stored.id,note:null,revision:Number(stored.revision)});return response({error:'This note is unavailable.'},403)}
    if((previous?.revision??null)!==input.expectedRevision&&stored?.change_id!==input.changeId)return response({error:'This note changed elsewhere. Your draft is retained.',code:'NOTEPAD_CONFLICT'},409);
    if(previous?.revision===0&&(!input.expectedLegacyVersion||input.expectedLegacyVersion!==previous.legacyVersion))return response({error:'This legacy note changed elsewhere. Your draft is retained.',code:'NOTEPAD_CONFLICT'},409);
    if(previous&&previous.authorId!==actor&&input.document===null)return response({error:'Only the creator can delete this note.'},403);
    if(input.document===null&&!previous)return response({error:'This note is unavailable.'},404);
    let document:NotepadDocument|null=null;
    let taggedPeople:string[]=[];
    if(input.document!==null){
      const earlier=previous?notepadDocument(previous):null;
      const replay=!!previous&&stored?.change_id===input.changeId;
      try { document=validateNotepadDocument(input.document,earlier,actor,new Date().toISOString()); } catch(error) { return response({error:error instanceof Error?error.message:'Invalid note.'},400); }
      if(previous&&previous.authorId!==actor&&(document.title!==previous.title||document.titleFontFamily!==(previous.titleFontFamily||'Comic Sans MS')))return response({error:'Only the creator can edit the note title or its font.'},403);
      if(previous&&previous.authorId!==actor&&!replay&&!sameAudience(document.audience,previous.audience))return response({error:'Only the creator can change sharing.'},403);
      for(const id of document.audience.people)if(!previous?.audience.people.includes(id)&&!state.people.some(p=>p.id===id&&p.active&&p.taggable&&p.recipientSelectable!==false))return response({error:'A selected recipient is no longer available.'},400);
      const explicit=new Set(document.audience.people);
      if(replay&&previous){
        // Restore the canonical result for an acknowledgement lost after the
        // commit. SQL still requires the entire result to equal that mutation.
        const tags=notepadPersonTagCounts(document);
        taggedPeople=previous.audience.people.filter(id=>!explicit.has(id)&&tags.has(id));
      }else{
        const tags=notepadPersonTagCounts(document,state.people);
        const olderTags=earlier?notepadPersonTagCounts(earlier,state.people):new Map<string,number>();
        taggedPeople=[...tags].filter(([id,total])=>!explicit.has(id)&&total>(olderTags.get(id)||0)).map(([id])=>id).sort();
      }
      if(document.audience.people.length+taggedPeople.length>500)return response({error:'The note can be shared with at most 500 individual recipients.'},400);
      document.audience=notepadAudienceWithPeople(document.audience,taggedPeople);
      if(replay&&previous&&previous.authorId!==actor&&!sameAudience(document.audience,previous.audience))return response({error:'Only the creator can change sharing.'},403);
      const added=document.attachments.filter(file=>file.kind==='file'&&!previous?.attachments.some(old=>old.id===file.id));
      if(added.length>20)return response({error:'Attach at most 20 new files at a time.'},400);
      if(added.length){const files=await auth.admin.from('cmpri_notepad_uploads').select('id,author_user_id,note_id,name,media_type,size_bytes,ready').eq('hotel_id',hotel).in('id',added.map(a=>a.id));
        if(files.error)return response({error:'Attachments could not be verified.'},503);
        for(const attachment of added){const file=files.data?.find(f=>f.id===attachment.id);if(!file||!file.ready||file.author_user_id!==actor||(file.note_id&&file.note_id!==input.id)||file.name!==attachment.name||file.media_type!==attachment.type||Number(file.size_bytes)!==attachment.size)return response({error:'An attachment is unavailable or belongs to another note.'},403)}
      }
    }
    const {data,error}=await auth.admin.rpc('cmpri_save_notepad',{p_hotel:hotel,p_actor:actor,p_id:input.id,p_expected:input.expectedRevision,p_change:input.changeId,p_document:document,p_source:previous?.revision===0?previous.legacySource:null,p_legacy_version:input.expectedLegacyVersion||null,...(taggedPeople.length?{p_tagged_people:taggedPeople}:{})});
    if(error){const status=error.code==='40001'?409:error.code==='42501'?403:error.code==='22023'?400:error.code==='54000'?422:503;return response({error:status===409?'This note changed elsewhere. Your draft is retained.':status===403?'This note is no longer shared with you.':'The note could not be saved. Your draft is retained.',...(status===409?{code:'NOTEPAD_CONFLICT'}:{})},status)}
    const row=(Array.isArray(data)?data[0]:data) as NotepadRow;if(!row)return response({error:'The save was not confirmed. Your draft is retained.'},503);
    const note=projectNotepadRow(row);if(note)await signNotepadAttachments(auth.admin,hotel,[note],state.legacyAliases);
    return response({id:row.id,note,revision:Number(row.revision),...(taggedPeople.length?{taggedPeople}:{})});
  } catch { return response({error:'Notepad could not be saved. Your draft is retained.'},503); }
}
export async function PATCH(request:NextRequest) {
  const auth=await principal(request);if(!auth)return response({error:'Sign in is required.'},401);
  let input;try{input=await readBody(request)}catch{return response({error:'Invalid note order.'},400)}
  if(!input||Array.isArray(input)||Object.keys(input).some(k=>k!=='order')||!Array.isArray(input.order)||input.order.length>5000||input.order.some((id:unknown)=>typeof id!=='string'||!NOTEPAD_UUID.test(id))||new Set(input.order).size!==input.order.length)return response({error:'Invalid note order.'},400);
  try {const state=await loadNotepad(auth.admin,auth.principal.hotelId,auth.principal.identity.id,false),visible=new Set(state.notes.map(n=>n.id));
    if(input.order.some((id:string)=>!visible.has(id)))return response({error:'Only available notes can be reordered.'},403);
    const {error}=await auth.admin.from('cmpri_notepad_order').upsert({hotel_id:auth.principal.hotelId,user_id:auth.principal.identity.id,note_ids:input.order},{onConflict:'hotel_id,user_id'});
    return error?response({error:'Your note order could not be saved.'},503):response({order:input.order});
  } catch {return response({error:'Your note order could not be saved.'},503)}
}
