import {NextRequest,NextResponse} from 'next/server';
import {requireUserAttempt} from '@/lib/server/auth';
import {canReviewEmployment,canReviewEmploymentDepartment} from '@/lib/employment-access';
export async function GET(request:NextRequest){
 const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
 const auth=await requireUserAttempt(request);
 if(!auth.ok||auth.mcp||!canReviewEmployment(auth.principal.identity,auth.principal.profile))return NextResponse.json({error:'Private work-account access required.'},{status:403,headers});
 const id=request.nextUrl.searchParams.get('id');if(!id||!/^[0-9a-f-]{36}$/i.test(id))return NextResponse.json({error:'Invalid application.'},{status:400,headers});
 const app=await auth.admin.from('employment_applications').select('answers->>department').eq('id',id).maybeSingle();
 if(app.error||!app.data||!canReviewEmploymentDepartment(auth.principal.identity,auth.principal.profile,app.data.department))return NextResponse.json({error:'Application unavailable.'},{status:404,headers});
 const result=await auth.admin.from('employment_resumes').select('file_name,original_pdf').eq('application_id',id).maybeSingle();
 if(result.error||!result.data)return NextResponse.json({error:'Attachment unavailable.'},{status:404,headers});
 const value=result.data.original_pdf;if(typeof value!=='string'||!/^\\x(?:[0-9a-f]{2})+$/i.test(value))return NextResponse.json({error:'Attachment unavailable.'},{status:503,headers});
 const bytes=Buffer.from(value.slice(2),'hex');
 return new Response(bytes,{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':"inline; filename*=UTF-8''"+encodeURIComponent(result.data.file_name),'Content-Security-Policy':"sandbox; default-src 'none'"}});
}
