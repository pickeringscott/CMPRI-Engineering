import {assertLocal,openStore,saveMedia,readLimited,MAX_MEDIA,apiError} from '../../../lib/local-store.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request){let db;try{const directory=assertLocal(request);const name=decodeURIComponent(request.headers.get('x-file-name')||'Attachment');const bytes=await readLimited(request,MAX_MEDIA);db=openStore(directory);return Response.json({media:saveMedia(db,bytes,name)},{headers:{'Cache-Control':'private, no-store'}});}catch(e){return apiError(e);}finally{db?.close();}}
