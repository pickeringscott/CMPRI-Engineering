import type { NextRequest } from "next/server";
import { getDashboardNotifications } from "@/lib/server/dashboard-notifications";
export { postDashboardNotifications as POST } from "@/lib/server/dashboard-notifications";
export async function GET(request: NextRequest) {
  return getDashboardNotifications(request);
}
