import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import { profileHasRole, profileIsChiefEngineerOrSystemAdmin } from "@/lib/server/roles";
export async function GET(request: NextRequest) {
  const auth=await requireUser(request);
  if(!auth) return NextResponse.json({error:"Sign in is required."},{status:401});
  const profile=auth.principal.profile;
  if(!allows(auth.principal,"view_dashboard") || !(profileIsChiefEngineerOrSystemAdmin(profile)||profileHasRole(profile,"technician")))
    return NextResponse.json({error:"Dashboard notification access is required."},{status:403});
  if(!Number.isFinite(Date.parse(request.nextUrl.searchParams.get("since") || "")))
    return NextResponse.json({error:"A valid notification cursor is required."},{status:400});
  // Durable inbox, not history discovery. Delayed/replayed intents cannot be skipped by a timestamp cursor.
  const result=await auth.admin.from("cmpri_dashboard_notifications")
    .select("notification_key,work_order_id,target_path,message,recorded_at,read_at")
    .eq("hotel_id",auth.principal.hotelId).eq("recipient_user_id",auth.principal.identity.id)
    .not("work_order_id","is",null).not("notification_key","like","new-order:%")
    .not("notification_key","like","work-order-mention:%").is("cleared_at",null)
    .order("recorded_at",{ascending:false}).limit(500);
  if(result.error) return NextResponse.json({error:"Notifications could not be loaded."},{status:503});
  return NextResponse.json({
    notifications:(result.data || []).filter(r=>!r.read_at).map(r=>({id:r.notification_key,work_order_id:r.work_order_id,target_path:r.target_path,message:r.message,recorded_at:r.recorded_at,is_read:false})),
    resolved_notification_ids:(result.data || []).filter(r=>r.read_at).map(r=>r.notification_key),
    checked_at:new Date().toISOString()
  },{headers:{"Cache-Control":"private, no-store"}});
}
