import type { CmpriClientSession } from "../auth/client-session";
import { canOpenEnseo, canOpenGss, canOpenRoomOperations, canOpenWeather } from "../dashboard/menu-access";
import { canReviewEmployment } from "../employment-access";
import { profileCanUseHoursTracker, roleKey } from "../server/roles";
import { canUseWinterPreparedness } from "../winter-preparedness-access";
import type { WorkspaceView } from "./workspace-resume";

/** Navigation eligibility only; every mounted screen/API retains its own guard.
 * Call after the server has freshly verified the account and property session.
 * This broad predicate is shared by both hosts so saving one section cannot
 * discard another host's authorized routes. Desktop launchers may further
 * restrict which of these views are actually restored on that desktop.
 */
export function canResumeWorkspaceView(session: CmpriClientSession, view: WorkspaceView): boolean {
  if (!session?.user?.id || !session.hotelId || !Array.isArray(session.capabilities)) return false;
  const has = (capability: string) => session.capabilities.includes(capability);
  const dashboard = ["view_dashboard", "view_work_orders", "view_pm", "receive_pool_closed_notifications"].some(has);
  if (view.kind === "list") return has("view_work_orders");
  // The same desktop window holds the personal inbox for readers and the
  // approval queue for reviewers; its own controls still enforce review access.
  if (view.kind === "approvals") return has("view_work_orders") || has("review_tickets");
  if (view.kind === "pool-status") return has("receive_pool_closed_notifications") || has("view_pool_log");
  if (view.kind !== "frame" || !view.href) return false;
  let path: string;
  try {
    const url = new URL(view.href, "https://workspace.invalid");
    if (url.origin !== "https://workspace.invalid") return false;
    path = url.pathname;
  } catch { return false; }
  if (path === "/engineering" || path === "/front-desk") return dashboard;
  if (path === "/technician") return roleKey(session.user.role) === "technician" && has("view_work_orders");
  if (path === "/work-orders") return has("submit");
  if (/^\/work-orders\/[^/]+$/.test(path)) return has("view_work_orders");
  if (path === "/staff-notes" || path === "/notes") return true;
  if (path === "/profile" || path === "/profile/ai-connection") return has("view_profiles");
  if (path === "/engineering/room-ranking" || path === "/engineering/room-ranker") return dashboard && has("view_work_orders");
  if (path === "/engineering/preventive-maintenance") return has("view_pm");
  if (["/management/equipment", "/engineering/parts", "/engineering/purchasing"].includes(path)) return has("manage_assets");
  if (path === "/management/rooms") return has("manage_rooms") && has("view_engineering_operations");
  if (path === "/management/users") return has("manage_users");
  if (path === "/feedback") return has("submit_feedback") || has("review_feedback");
  if (path === "/engineering/pool-log") return has("view_pool_log");
  if (path === "/pool") return has("receive_pool_closed_notifications") || has("view_pool_log");
  if (path === "/engineering/hours-tracker") return profileCanUseHoursTracker(session.user);
  if (path === "/engineering/winter-preparedness") return canUseWinterPreparedness(session.user);
  if (path === "/engineering/employment" || /^\/engineering\/employment\/[^/]+$/.test(path)) return canReviewEmployment(session.user, session.user);
  if (path === "/engineering/gss") return canOpenGss(session.user);
  if (path === "/engineering/room-operations") return canOpenRoomOperations(session.user);
  if (path === "/engineering/enseo-assignments") return canOpenEnseo(session.user);
  if (path === "/engineering/import-work-orders") return has("edit_tickets");
  if (path === "/previews/cmpri-weather-preview.html") return process.env.NEXT_PUBLIC_CMPRI_WEATHER_PREVIEW === "1" && canOpenWeather(session.user);
  return false;
}
