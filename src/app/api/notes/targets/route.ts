import {NextRequest,NextResponse} from 'next/server';
import {requireUser} from '@/lib/server/auth';
import {staffNoteDirectory} from '@/lib/server/staff-note-directory';
const headers={'Cache-Control':'private, no-store'};
/** Reuse CMPRI's property-scoped directory without reading the Staff Notes feed. */
export async function GET(request:NextRequest){
 const auth=await requireUser(request);if(!auth)return NextResponse.json({error:'Sign in is required.'},{status:401,headers});
 try{const directory=await staffNoteDirectory(auth.admin,auth.principal.hotelId);return NextResponse.json({mentions:directory.mentions.map(({id,kind,label,description})=>({id,kind,label,description,userIds:[]}))},{headers})}
 catch{return NextResponse.json({error:'Mention targets could not be loaded. Try again.'},{status:503,headers})}
}
