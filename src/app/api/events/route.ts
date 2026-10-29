import {canReviewEmployment} from "@/lib/employment-access";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import type { Capability } from "@/lib/server/roles";
import { RESOURCES, type Resource } from "@/lib/events/resources";
import { canViewRoomRanker } from "@/lib/room-ranker-access";
const restricted: Partial<Record<Resource,Capability>> = {
  feedback: "review_feedback", "room-operations": "view_engineering_operations",
  catalog: "view_engineering_operations", purchasing: "view_engineering_operations",
  enseo: "view_engineering_operations", gss: "view_engineering_operations",
  drive: "operate_integrations", users: "manage_users", pm: "view_pm",
};
export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({error:"Sign in required."},{status:401});
  const { principal, admin } = auth;
  const resources = RESOURCES.filter(key => (key !== "employment" || canReviewEmployment(principal.identity,principal.profile)) && (key !== "room-ranker" || canViewRoomRanker(principal)) && (!restricted[key] || allows(principal,restricted[key]!)));
  const {data,error} = await admin.from("cmpri_resource_revisions")
    .select("resource,scope,revision").eq("hotel_id",principal.hotelId)
    .in("resource",resources).or("scope.eq.*,scope.eq." + principal.identity.id);
  if(error) return NextResponse.json({error:"Live updates require the event migration."},{status:503});
  return NextResponse.json({user_id:principal.identity.id,hotel_id:principal.hotelId,revisions:data || []},
    {headers:{"Cache-Control":"private, no-store"}});
}

