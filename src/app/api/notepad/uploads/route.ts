import { NextRequest,NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { STAFF_FILE_BUCKET,staffFileInput } from '@/lib/staff-note-media';
import { NOTEPAD_UUID } from '@/lib/notepad';
import { notepadAttachmentURL,resolveNotepadAttachment } from '@/lib/server/notepad-store';
const headers={'Cache-Control':'private, no-store'};
const response=(body:unknown,status=200)=>NextResponse.json(body,{status,headers});
async function principal(request:NextRequest){const auth=await requireUser(request),property=request.headers.get('x-cmpri-property');return auth&&(!property||property===auth.principal.hotelId)?auth:null}
export async function POST(request:NextRequest){
 const auth=await principal(request);if(!auth)return response({error:'Sign in is required.'},401);
 const file=staffFileInput(await request.json().catch(()=>null));if(!file)return response({error:'Choose a valid file up to 100 MB.'},400);
 const hotel=auth.principal.hotelId,user=auth.principal.identity.id;
 const previous=await auth.admin.from('cmpri_notepad_uploads').select('id,name,media_type,size_bytes,note_id').eq('hotel_id',hotel).eq('author_user_id',user).eq('id',file.id).maybeSingle();
 if(previous.error)return response({error:'Upload could not be checked.'},503);
 if(previous.data&&(previous.data.name!==file.name||previous.data.media_type!==file.type||Number(previous.data.size_bytes)!==file.size))return response({error:'Upload ID is already in use.'},409);
 const path=`${hotel}/${user}/notepad/${file.id}`;
 if(!previous.data){const inserted=await auth.admin.from('cmpri_notepad_uploads').insert({id:file.id,hotel_id:hotel,author_user_id:user,name:file.name,media_type:file.type,size_bytes:file.size,storage_path:path,ready:false});if(inserted.error)return response({error:'Upload could not be prepared.'},409)}
 const signed=await auth.admin.storage.from(STAFF_FILE_BUCKET).createSignedUploadUrl(path,{upsert:false});if(signed.error||!signed.data)return response({error:'Upload could not be prepared. Your draft is retained.'},503);
 return response({id:file.id,path,token:signed.data.token});
}
export async function PUT(request:NextRequest){
 const auth=await principal(request);if(!auth)return response({error:'Sign in is required.'},401);
 const input=await request.json().catch(()=>null);if(!input||Object.keys(input).some(k=>k!=='id')||!NOTEPAD_UUID.test(input.id||''))return response({error:'Choose a valid upload.'},400);
 const lookup=await auth.admin.from('cmpri_notepad_uploads').select('id,storage_path,name,size_bytes,media_type,ready,note_id').eq('id',input.id).eq('hotel_id',auth.principal.hotelId).eq('author_user_id',auth.principal.identity.id).maybeSingle();
 if(lookup.error)return response({error:'Upload could not be checked.'},503);const row=lookup.data;if(!row)return response({error:'Upload not found.'},404);
 if(row.note_id&&!await resolveNotepadAttachment(auth.admin,auth.principal.hotelId,auth.principal.identity.id,row.note_id,row.id))return response({error:'This file is no longer shared with your account.'},403);
 const object=await auth.admin.storage.from(STAFF_FILE_BUCKET).info(row.storage_path);
 if(object.error||Number(object.data?.size)!==Number(row.size_bytes)||object.data?.contentType!==row.media_type)return response({error:'Stored file size or type could not be verified.'},409);
 const saved=await auth.admin.from('cmpri_notepad_uploads').update({ready:true}).eq('id',row.id).eq('hotel_id',auth.principal.hotelId).eq('author_user_id',auth.principal.identity.id).select('id').maybeSingle();if(saved.error||!saved.data)return response({error:'Upload verification was not confirmed.'},409);
 const signed=await auth.admin.storage.from(STAFF_FILE_BUCKET).createSignedUrl(row.storage_path,3600);if(signed.error||!signed.data)return response({error:'The file is uploaded but its preview could not be opened.'},503);
 return response({id:row.id,ready:true,url:notepadAttachmentURL(signed.data.signedUrl,row.media_type,row.name)});
}
