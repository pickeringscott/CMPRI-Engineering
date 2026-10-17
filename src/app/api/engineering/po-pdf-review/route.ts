import {NextRequest,NextResponse} from 'next/server';
import {requireCapability} from '@/lib/server/auth';
import {inspectPoPdf} from '@/lib/po-pdf';
export const runtime='nodejs';
export async function POST(request:NextRequest){
 const auth=await requireCapability(request,'manage_assets');if(!auth)return NextResponse.json({error:'Parts-management permission required.'},{status:403});
 if(process.env.CMPRI_PO_ENABLED!=='true')return NextResponse.json({error:'PO review is not enabled.'},{status:409});
 const size=Number(request.headers.get('content-length'));if(!Number.isFinite(size)||size<=0||size>10*1024*1024+65536)return NextResponse.json({error:'Provide a PDF no larger than 10 MB.'},{status:413});
 try{const form=await request.formData(),file=form.get('file');if(!(file instanceof File)||file.size>10*1024*1024)return NextResponse.json({error:'PDF file required.'},{status:400});return NextResponse.json(await inspectPoPdf(new Uint8Array(await file.arrayBuffer())),{headers:{'Cache-Control':'no-store'}});}catch{return NextResponse.json({error:'PDF could not be read. No source or order was saved.'},{status:422});}
}
