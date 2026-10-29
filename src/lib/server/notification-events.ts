import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { profileAllows, profileHasRole, profileIsChiefEngineerOrSystemAdmin, receivesWorkOrderNotifications } from "@/lib/server/roles";
import { recordNotifications } from "@/lib/server/dashboard-notifications";
import { engineerHistoryNotifications, technicianHistoryNotifications, technicianViewNotificationsForEngineer, newWorkOrderNotification, type WorkOrderHistoryNotification, type WorkOrderTechnicianView, type WorkOrderNotification } from "@/lib/dashboard/work-order-notifications";
type Profile = {id:string;role:string;email?:string;secondary_roles?:string[];full_name:string|null;active:boolean};
type SourceEvent = {id:string;kind:string;source_id:string;hotel_id:string;payload:Record<string,unknown>;lease_token:string};
/** Consume only committed, durable event identities. Replay is idempotent per recipient/key. */
export async function materializeNotificationEvents(admin: SupabaseClient) {
  const claim = await admin.rpc("cmpri_claim_notification_events",{p_hotel:HOTEL_ID,p_limit:100});
  if(claim.error) throw new Error("Notification event queue unavailable.");
  const events = (claim.data || []) as SourceEvent[];
  if(!events.length) return 0;
  const members = await admin.from("hotel_members").select("user_id").eq("hotel_id",HOTEL_ID).eq("active",true);
  if(members.error) throw new Error("Event recipients could not be verified.");
  const ids = (members.data || []).map(m=>m.user_id);
  const profiles: Profile[] = [];
  for(let i=0;i<ids.length;i+=200) {
    const result=await admin.from("profiles").select("id,email,role,secondary_roles,full_name,active").eq("active",true).in("id",ids.slice(i,i+200));
    if(result.error) throw new Error("Event recipients could not be verified.");
    profiles.push(...(result.data || []) as Profile[]);
  }
  for(const event of events) {
    if(event.hotel_id!==HOTEL_ID) throw new Error("Event property mismatch.");
    let newOrderRead = false;
    if (event.kind === "history" && event.payload.event_type === "created") {
      const workOrder = String(event.payload.work_order_id);
      const [views, transitions] = await Promise.all([
        admin.from("cmpri_work_order_technician_views").select("id").eq("hotel_id",HOTEL_ID).eq("work_order_id",workOrder).limit(1),
        admin.from("cmpri_work_order_history").select("old_status,new_status").eq("hotel_id",HOTEL_ID).eq("work_order_id",workOrder)
          .in("event_type",["status_changed","closed","reopened"]).in("new_status",["In Progress","Pending Verification"])
          .gte("recorded_at",String(event.payload.recorded_at)),
      ]);
      if (views.error || transitions.error) throw new Error("Seen status could not be verified.");
      newOrderRead = !!views.data?.length || !!transitions.data?.some(row => row.old_status !== row.new_status);
    }
    for(const profile of profiles) {
      let notifications: WorkOrderNotification[] = [];
      const chief=profileIsChiefEngineerOrSystemAdmin(profile);
      if(event.kind==="feedback" && profileAllows(profile,"review_feedback")) {
        notifications=[{id:"feedback:"+event.source_id,work_order_id:null,target_path:"/feedback",
          message:"New feedback is ready for review.",recorded_at:String(event.payload.created_at)}];
      } else if(receivesWorkOrderNotifications(profile)) {
        if(event.kind==="view" && chief) notifications=technicianViewNotificationsForEngineer([event.payload as unknown as WorkOrderTechnicianView]);
        if(event.kind==="history") {
          const history=event.payload as unknown as WorkOrderHistoryNotification;
          if(history.event_type==="created") {
            const snapshot=history.snapshot || {};
            notifications=[newWorkOrderNotification({id:history.work_order_id,display_id:String(snapshot.display_id || ""),room:String(snapshot.room || ""),issue:String(snapshot.issue || ""),status:history.new_status,created_at:history.recorded_at})];
          } else if(chief) notifications=engineerHistoryNotifications([history],profile.id);
          else if(profileHasRole(profile,"technician")) notifications=technicianHistoryNotifications([history],{id:profile.id,name:profile.full_name || ""});
        }
      }
      if (newOrderRead && !chief && profileHasRole(profile,"technician")) notifications = notifications.map(item => ({...item,is_read:true}));
      if(!await recordNotifications(admin,profile.id,notifications,profile)) throw new Error("Event notification could not be persisted.");
    }
    const done=await admin.from("cmpri_notification_events").update({processed_at:new Date().toISOString(),lease_until:null})
      .eq("id",event.id).eq("hotel_id",HOTEL_ID).eq("lease_token",event.lease_token);
    if(done.error) throw new Error("Event acknowledgement failed; idempotent retry remains pending.");
  }
  return events.length;
}

