import {importResponseBody} from '@/lib/server/import-response';
import {NextRequest,NextResponse} from 'next/server';
import {requireCapability} from '@/lib/server/auth';
import {inspectPoPdf} from '@/lib/po-pdf';
import {readImportUpload} from '@/lib/server/import-upload';
export const runtime='nodejs';
export async function POST(request:NextRequest){
 const auth=await requireCapability(request,'manage_assets');if(!auth)return NextResponse.json({error:'Parts-management permission required.'},{status:403});
 if(process.env.CMPRI_PO_ENABLED!=='true')return NextResponse.json({error:'PO review is not enabled.'},{status:409});
 if(request.headers.get('content-type')?.includes('application/json')){try{const body=await request.json();const {bytes}=await readImportUpload(auth.admin,auth.principal.hotelId,auth.principal.identity.id,body.upload,'po-pdf');return NextResponse.json(await importResponseBody(auth.admin,auth.principal.hotelId,auth.principal.identity.id,await inspectPoPdf(bytes)),{headers:{'Cache-Control':'no-store'}});}catch{return NextResponse.json({error:'The uploaded PDF could not be verified or read.'},{status:422});}}
 const size=Number(request.headers.get('content-length'));if(!Number.isFinite(size)||size<=0||size>100*1024*1024+65536)return NextResponse.json({error:'Provide a PDF no larger than 100 MB.'},{status:413});
 try{const form=await request.formData(),file=form.get('file');if(!(file instanceof File)||file.size>100*1024*1024)return NextResponse.json({error:'PDF file required.'},{status:400});return NextResponse.json(await importResponseBody(auth.admin,auth.principal.hotelId,auth.principal.identity.id,await inspectPoPdf(new Uint8Array(await file.arrayBuffer()))),{headers:{'Cache-Control':'no-store'}});}catch{return NextResponse.json({error:'PDF could not be read. No source or order was saved.'},{status:422});}
}
