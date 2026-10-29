import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { getDashboardNotifications } from "@/lib/server/dashboard-notifications";
import { getPoolStatus } from "@/lib/server/pool-status-response";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const resources = [...new Set(request.nextUrl.searchParams.getAll("resource"))];
  if (!resources.length || resources.some((key) => key !== "notifications" && key !== "pool")) {
    return NextResponse.json({ error: "Invalid refresh resources." }, { status: 400 });
  }
  // Request-local reuse only. Each resource still applies its original permission checks.
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  const entries = await Promise.all(resources.map(async (key) => {
    try {
      const response = key === "pool"
        ? await getPoolStatus(request, auth)
        : await getDashboardNotifications(request, auth);
      return [key, { status: response.status, data: await response.json() }];
    } catch {
      return [key, { status: 503, data: { error: "Refresh temporarily unavailable." } }];
    }
  }));
  return NextResponse.json(Object.fromEntries(entries), { headers: { "Cache-Control": "private, no-store" } });
}
