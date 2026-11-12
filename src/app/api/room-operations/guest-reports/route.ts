import { importResponseBody } from '@/lib/server/import-response';
import { readImportUpload } from '@/lib/server/import-upload';
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireCapability } from "@/lib/server/auth";
import { HOTEL_TIME_ZONE } from "@/lib/constants";
import { hotelDateAt } from "@/lib/room-operations-reports";
import { guestReportIdentity,parseGuestReport,validateGuestReportBatch,roomsFromGuestReports,type GuestRoom,type GuestReport,type GuestReportKind } from "@/lib/room-guest-reports";

const headers={"Cache-Control":"private, no-store"};
const hash=(value:unknown)=>createHash("sha256").update(guestReportIdentity(value)).digest("hex");
export async function POST(request:NextRequest){
  const auth=await requireCapability(request,"edit_tickets");
  if(!auth)return NextResponse.json({error:"Engineering ticket-edit permission is required."},{status:403,headers});
  const body=await request.json().catch(()=>null);
  if(Array.isArray(body?.uploads)) {
    if(body.uploads.length<1||body.uploads.length>3)return NextResponse.json({error:"Choose one to three reports."},{status:400,headers});
    try { body.files=[];for(const upload of body.uploads){const file=await readImportUpload(auth.admin,auth.principal.hotelId,auth.principal.identity.id,upload,'guest-report');body.files.push({name:file.descriptor.name,text:new TextDecoder('utf-8',{fatal:true}).decode(file.bytes)});} }
    catch {return NextResponse.json({error:"The uploaded reports could not be verified."},{status:400,headers});}
  }
  if(!Array.isArray(body?.files)||!body.files.length||body.files.length>3||body.files.some((f:{name?:unknown;text?:unknown})=>typeof f?.name!=="string"||typeof f?.text!=="string"||new TextEncoder().encode(f.text).byteLength>100*1024*1024))return NextResponse.json({error:"Choose one to three valid reports."},{status:400,headers});
  try{
    const respond=async(body:unknown)=>NextResponse.json(await importResponseBody(auth.admin,auth.principal.hotelId,auth.principal.identity.id,body),{headers});
    const hotel=auth.principal.hotelId;
    const [history,locations]=await Promise.all([
      auth.admin.from("cmpri_room_operation_imports").select("id,source_rows,report_date,status_printed_time,status_fingerprint,departures_fingerprint").eq("hotel_id",hotel).order("report_date",{ascending:false}).order("status_printed_time",{ascending:false,nullsFirst:false}).order("uploaded_at",{ascending:false}).limit(1),
      auth.admin.from("locations").select("room_number").eq("hotel_id",hotel).eq("active",true).eq("location_type","Guest Room"),
    ]);
    if(history.error||locations.error)throw Error("The current room inventory and accepted report could not be verified.");
    const latest=history.data?.[0],previousRows=(Array.isArray(latest?.source_rows)?latest.source_rows:[]) as GuestRoom[];
    const previous=(previousRows.find(r=>r.guest_report_bundle)?.guest_report_bundle||{}) as Partial<Record<GuestReportKind,GuestReport>>;
    const reports=body.files.map((f:{name:string;text:string})=>parseGuestReport(f.name,f.text));
    const bundle=validateGuestReportBatch(reports,previous,hotelDateAt(new Date(),HOTEL_TIME_ZONE));
    // Also compare the old two-report baseline during the first guest-list import.
    if(!previous.guests&&latest&&(`${bundle.guests.date}T${bundle.guests.time}`<=`${latest.report_date}T${latest.status_printed_time||"00:00:00"}`))throw Error("The guest list must be newer than the current accepted import.");
    const inventory=[...new Set((locations.data||[]).map(l=>String(l.room_number||"")).filter(Boolean))];
    if(!inventory.length)throw Error("No active guest rooms were found. Nothing was imported.");
    const rows=roomsFromGuestReports(bundle,inventory,previousRows);
    const coreHash=hash(bundle.guests),batchHash=hash(bundle);
    const uploaded=new Date().toISOString();
    const saved=rows.map((row,index)=>({...row,report_date:bundle.guests.date,source_uploaded_at:uploaded,checkout_source_report_date:bundle.guests.date,checkout_source_uploaded_at:uploaded,
      status_printed_date:bundle.guests.date,status_printed_time:bundle.guests.time,status_fingerprint:coreHash,departures_fingerprint:batchHash,...(index===0?{guest_report_bundle:bundle}:{}),report_pages:[1]}));
    if(body.validateOnly===true)return respond({ok:true,date:bundle.guests.date,rows:saved,previousId:latest?.id||null});
    if(latest?.status_fingerprint===coreHash&&latest?.departures_fingerprint===batchHash)return respond({ok:true,import_id:latest.id,date:bundle.guests.date,rows:previousRows});
    if(body.previousId!==(latest?.id||null))return NextResponse.json({error:"The accepted room report changed. Review the import again."},{status:409,headers});
    const committed=await auth.admin.rpc("cmpri_commit_guest_reports",{p_hotel:hotel,p_actor:auth.principal.identity.id,p_actor_name:auth.principal.profile.full_name||"CMPRI Staff",p_date:bundle.guests.date,p_previous:latest?.id||null,p_rows:saved});
    if(committed.error)return NextResponse.json({error:committed.error.message},{status:409,headers});
    return respond({ok:true,import_id:committed.data,date:bundle.guests.date,rows:saved});
  }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Reports could not be verified. Nothing was imported."},{status:422,headers});}
}
