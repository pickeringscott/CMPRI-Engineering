import {NextRequest,NextResponse} from 'next/server';
import {requireUser} from '@/lib/server/auth';
import {STAFF_FILE_BUCKET,staffFileInput} from '@/lib/staff-note-media';
const headers={'Cache-Control':'private, no-store'};
/** Signed uploads always belong to the authenticated property/account. No client paths. */
export async function POST(request:NextRequest) {
 const auth=await requireUser(request);
 if(!auth)return NextResponse.json({error:'Sign in is required.'},{status:401,headers});
 const file=staffFileInput(await request.json().catch(()=>null));
 if(!file)return NextResponse.json({error:'Choose a file of 1 byte to 100 MB with a valid name and type.'},{status:400,headers});
 const hotel=auth.principal.hotelId,user=auth.principal.identity.id;
 const table=auth.admin.from('cmpri_staff_note_uploads');
 const previous=await table.select('id,name,media_type,size_bytes,storage_path,note_id').eq('id',file.id).eq('hotel_id',hotel).eq('author_user_id',user).maybeSingle();
 if(previous.error)return NextResponse.json({error:'Upload could not be checked.'},{status:503,headers});
 if(previous.data&&(previous.data.note_id||previous.data.name!==file.name||previous.data.media_type!==file.type||Number(previous.data.size_bytes)!==file.size))return NextResponse.json({error:'Upload ID is already in use.'},{status:409,headers});
 const path=`${hotel}/${user}/${file.id}`;
 if(!previous.data){
  const insert=await auth.admin.from('cmpri_staff_note_uploads').insert({id:file.id,hotel_id:hotel,author_user_id:user,name:file.name,media_type:file.type,size_bytes:file.size,storage_path:path,ready:false});
  if(insert.error)return NextResponse.json({error:'Upload could not be prepared.'},{status:409,headers});
 }
 const signed=await auth.admin.storage.from(STAFF_FILE_BUCKET).createSignedUploadUrl(path,{upsert:false});
 if(signed.error||!signed.data)return NextResponse.json({error:'Upload could not be prepared. Your draft is retained.'},{status:503,headers});
 return NextResponse.json({id:file.id,path,token:signed.data.token},{headers});
}
export async function PUT(request:NextRequest) {
 const auth=await requireUser(request);
 if(!auth)return NextResponse.json({error:'Sign in is required.'},{status:401,headers});
 const input=await request.json().catch(()=>null);
 if(!input||Object.keys(input).some(key=>key!=='id')||typeof input.id!=='string'||!/^[0-9a-f-]{36}$/i.test(input.id))return NextResponse.json({error:'A valid upload ID is required.'},{status:400,headers});
 const lookup=await auth.admin.from('cmpri_staff_note_uploads').select('id,storage_path,size_bytes,media_type,ready,note_id').eq('id',input.id).eq('hotel_id',auth.principal.hotelId).eq('author_user_id',auth.principal.identity.id).maybeSingle();
 if(lookup.error)return NextResponse.json({error:'Upload could not be checked.'},{status:503,headers});
 const row=lookup.data;
 if(!row)return NextResponse.json({error:'Upload not found.'},{status:404,headers});
 if(row.note_id)return NextResponse.json({error:'This file has already been posted.'},{status:409,headers});
 const object=await auth.admin.storage.from(STAFF_FILE_BUCKET).info(row.storage_path);
 if(object.error||Number(object.data?.size)!==Number(row.size_bytes)||object.data?.contentType!==row.media_type)return NextResponse.json({error:'Stored file size or type could not be verified. Your draft is retained.'},{status:409,headers});
 const saved=await auth.admin.from('cmpri_staff_note_uploads').update({ready:true}).eq('id',row.id).eq('hotel_id',auth.principal.hotelId).eq('author_user_id',auth.principal.identity.id).is('note_id',null).select('id').maybeSingle();
 if(saved.error||!saved.data)return NextResponse.json({error:'Upload verification was not confirmed.'},{status:409,headers});
 return NextResponse.json({id:row.id,ready:true},{headers});
}
