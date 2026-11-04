import {assertLocal,openStore,listNotes,saveNote,readLimited,apiError} from '../../../lib/local-store.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request){let db;try{db=openStore(assertLocal(request));return Response.json({notes:listNotes(db),backend:'isolated-local'},{headers:{'Cache-Control':'private, no-store'}});}catch(e){return apiError(e);}finally{db?.close();}}
export async function POST(request){let db;try{const directory=assertLocal(request);const input=JSON.parse((await readLimited(request,65536)).toString());db=openStore(directory);return Response.json({note:saveNote(db,input)},{headers:{'Cache-Control':'private, no-store'}});}catch(e){return apiError(e);}finally{db?.close();}}
