import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { requireUserAttempt } from "@/lib/server/auth";
import { canReviewEmployment, employmentDepartments } from "@/lib/employment-access";
import { validateEmployment } from "@/lib/employment-validation.mjs";

const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  let sameOrigin = false;
  try { const source = new URL(origin || ""); sameOrigin = source.host === request.headers.get("host") && (source.protocol === "https:" || (process.env.NODE_ENV !== "production" && source.protocol === "http:")); } catch { /* Reject missing or malformed origins. */ }
  if (!sameOrigin) return NextResponse.json({ error: "Invalid origin." }, { status: 403, headers });
  const reader=request.body?.getReader();if(!reader)return NextResponse.json({error:"Questionnaire required."},{status:400,headers});
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4*1024*1024){await reader.cancel();return NextResponse.json({error:"Choose a PDF up to 3 MB."},{status:413,headers});}chunks.push(part.value);}
  let body:Record<string,unknown>;let pdf:Buffer|null=null;let filename:string|null=null;let id:string;
  try {
   const contentType=request.headers.get('content-type')||'';
   if(contentType.startsWith('multipart/form-data')) {
    const form=await new Response(Buffer.concat(chunks),{headers:{'content-type':contentType}}).formData();
    body=JSON.parse(String(form.get('answers')));id=String(form.get('submissionId'));
    const file=form.get('resume');if(file!==null){if(!(file instanceof File)||file.size<5||file.size>3*1024*1024||!file.name.toLowerCase().endsWith('.pdf'))throw Error();pdf=Buffer.from(await file.arrayBuffer());if(pdf.subarray(0,5).toString()!=='%PDF-')throw Error();filename=file.name.replace(/[\\/\x00-\x1f\x7f]/g,'_').slice(0,180);}
   }else if(contentType.startsWith('application/json')){body=JSON.parse(Buffer.concat(chunks).toString());id=crypto.randomUUID();body.department??='maintenance';}else throw Error();
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw Error();
  }catch{return NextResponse.json({error:"Check the questionnaire and PDF attachment."},{status:400,headers});}
  const validation=validateEmployment(body);
  if(!validation.ok||!validation.value||body.website)return NextResponse.json({error:"Check the required fields."},{status:400,headers});
  const admin=createSupabaseAdmin();if(!admin)return NextResponse.json({error:"Submission temporarily unavailable."},{status:503,headers});
  const {error}=await admin.rpc('submit_employment_with_resume',{p_id:id,p_answers:validation.value,p_file_name:filename,p_pdf:pdf?'\\x'+pdf.toString('hex'):null});
  if(error)return NextResponse.json({error:"Submission unavailable. Please retry without changing the form."},{status:error.code==='P0001'?409:503,headers});
  return NextResponse.json({ok:true,id},{status:201,headers});
}

export async function GET(request: NextRequest) {
  const auth = await requireUserAttempt(request);
  if (!auth.ok || auth.mcp || !canReviewEmployment(auth.principal.identity,auth.principal.profile)) return NextResponse.json({ error: "Private work-account access required." }, { status: 403, headers });
  const id = request.nextUrl.searchParams.get("id");
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Invalid application." }, { status: 400, headers });
  const departments=employmentDepartments(auth.principal.identity,auth.principal.profile);
  let query = auth.admin.from("employment_applications").select(id ? "id,created_at,answers" : "id,created_at,answers->>name,answers->>email,answers->>department");
  query=departments.length===2?query.or("answers->>department.is.null,answers->>department.eq.maintenance,answers->>department.eq.front"):departments[0]==='front'?query.eq("answers->>department","front"):query.or("answers->>department.is.null,answers->>department.eq.maintenance");
  const { data, error } = id ? await query.eq("id", id).maybeSingle() : await query.order("created_at", { ascending: false }).limit(200);
  if (error) return NextResponse.json({ error: "Applications unavailable." }, { status: 503, headers });
  const resume = id && data ? await auth.admin.from("employment_resumes").select("file_name").eq("application_id",id).maybeSingle() : null;
  const application: Record<string, unknown> | null = id && data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  return NextResponse.json(id ? { application: application ? {...application,resumeName:resume?.data?.file_name||null}:null } : { applications: data }, { headers });
}

