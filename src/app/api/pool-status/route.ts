export const dynamic = 'force-dynamic';
import type { NextRequest } from "next/server";
import { getPoolStatus } from "@/lib/server/pool-status-response";
export { postPoolStatus as POST } from "@/lib/server/pool-status-response";
export async function GET(request: NextRequest) {
  return getPoolStatus(request);
}
