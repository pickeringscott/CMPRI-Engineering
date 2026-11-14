import {NextRequest,NextResponse} from 'next/server';
import {requireUser} from '@/lib/server/auth';
import {validNoteDocument,type GeneralNote,type NoteDocument} from '@/lib/general-notes';
const headers={'Cache-Control':'private, no-store'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row={id:string;document:NoteDocument|null;revision:number;updated_at:string;deleted_at:string|null;change_id:string};
function project(row:Row):GeneralNote|null{return row.document?{...row.document,id:row.id,revision:Number(row.revision),updated:Date.parse(row.updated_at)}:null}
async function principal(request:NextRequest){const auth=await requireUser(request);if(!auth)return null;const hotel=request.headers.get('x-cmpri-property');return hotel&&hotel!==auth.principal.hotelId?null:auth}
export async function GET(request:NextRequest){
 const auth=await principal(request);if(!auth)return NextResponse.json({error:'Sign in is required.'},{status:401,headers});
 const id=request.nextUrl.searchParams.get('id');
 if(id&&!uuid.test(id))return NextResponse.json({error:'Invalid note.'},{status:400,headers});
 const owner=auth.principal.identity.id,hotel=auth.principal.hotelId;
 if(id){const {data,error}=await auth.admin.from('cmpri_general_notes').select('id,document,revision,updated_at,deleted_at,change_id').eq('hotel_id',hotel).eq('user_id',owner).eq('id',id).maybeSingle();if(error)return NextResponse.json({error:'Notes could not be loaded. Reconnect to try again.'},{status:503,headers});return NextResponse.json({note:data?project(data as unknown as Row):null},{headers})}
 const {data,error}=await auth.admin.from('cmpri_general_notes').select('id,title,revision,updated_at').eq('hotel_id',hotel).eq('user_id',owner).is('deleted_at',null).order('updated_at',{ascending:false}).limit(500);if(error)return NextResponse.json({error:'Notes could not be loaded. Reconnect to try again.'},{status:503,headers});
 return NextResponse.json({notes:(data||[]).map(row=>({id:row.id,title:row.title,revision:Number(row.revision),updated:Date.parse(row.updated_at)}))},{headers});
}
// Bound the actual stream, not only Content-Length (which callers can omit).
async function bodyText(request:NextRequest){const reader=request.body?.getReader();if(!reader)return '';const decoder=new TextDecoder();let size=0,text='';try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2_097_152){await reader.cancel();return null}text+=decoder.decode(value,{stream:true})}return text+decoder.decode()}finally{reader.releaseLock()}}
export async function PUT(request:NextRequest){
 const auth=await principal(request);if(!auth)return NextResponse.json({error:'Sign in is required.'},{status:401,headers});
 const raw=await bodyText(request);if(raw===null)return NextResponse.json({error:'This note is too large to sync.'},{status:413,headers});
 let body;try{body=JSON.parse(raw)}catch{return NextResponse.json({error:'A valid note is required.'},{status:400,headers})}
 if(!body||Array.isArray(body)||Object.keys(body).some(key=>!['id','expectedRevision','changeId','document'].includes(key))||!uuid.test(body.id||'')||!uuid.test(body.changeId||'')
  ||!(body.expectedRevision===null||(Number.isSafeInteger(body.expectedRevision)&&body.expectedRevision>0))||!(body.document===null||validNoteDocument(body.document)))return NextResponse.json({error:'Supply a valid note and its loaded revision.'},{status:400,headers});
 const {data,error}=await auth.admin.rpc('cmpri_save_general_note',{p_hotel:auth.principal.hotelId,p_actor:auth.principal.identity.id,p_id:body.id,p_expected:body.expectedRevision,p_change:body.changeId,p_document:body.document});
 if(error){const status=error.code==='40001'?409:error.code==='42501'?403:error.code==='54000'?422:error.code==='22023'?400:503;return NextResponse.json({error:status===409?'This note changed on another device. Your local draft is safe.':status===422?'Your notebook has reached its note limit.':'The note could not be synced. Your local draft is safe.'},{status,headers})}
 const row=(Array.isArray(data)?data[0]:data) as Row;return NextResponse.json({note:project(row),id:row.id,revision:Number(row.revision)},{headers});
}
