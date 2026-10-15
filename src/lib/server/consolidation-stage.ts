import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseAdmin } from "./supabase-admin";

/** The marker and canonical schema commit together. Never cache across cutover. */
export async function dispatchConsolidation(request: NextRequest, legacy: (request: NextRequest)=>Promise<NextResponse>) {
  const admin=createSupabaseAdmin();
  if(!admin)return NextResponse.json({error:"Equipment database configuration is unavailable."},{status:503});
  const {data,error}=await admin.rpc("cmpri_consolidation_ready");
  // Only an absent function selects the baseline. Authentication/connectivity failures fail closed.
  const absent=error?.code==="PGRST202";
  if(error&&!absent)return NextResponse.json({error:"Equipment release state could not be verified. Retry shortly."},{status:503});
  const ready=!absent&&data===true;
  if(request.method==="GET"&&request.nextUrl.searchParams.get("mode")==="consolidation")return NextResponse.json({ready},{headers:{"Cache-Control":"no-store"}});
  if(ready)return null;
  if(request.method==="GET"&&request.nextUrl.searchParams.get("mode")==="stored")return NextResponse.json({error:"The consolidated importer is not active yet. Reopen this dialog after cutover."},{status:503});
  if(request.method!=="GET"){
    const clone=request.clone();
    if(clone.headers.get("content-type")?.includes("multipart/form-data")){
      const form=await clone.formData();
      if(form.get("import_action"))return NextResponse.json({error:"Consolidation is not active. No association was written."},{status:503});
    }
  }
  return legacy(request);
}
