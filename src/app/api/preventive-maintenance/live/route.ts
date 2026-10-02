import { NextRequest, NextResponse } from "next/server";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";

function isMonday(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === value
    && date.getUTCDay() === 1;
}

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!allows(auth.principal, "view_dashboard")) {
    return NextResponse.json({ error: "Engineering dashboard access is required." }, { status: 403 });
  }

  const week = request.nextUrl.searchParams.get("week") || "";
  if (!isMonday(week)) {
    return NextResponse.json({ error: "Select a week beginning on Monday." }, { status: 400 });
  }

  return NextResponse.json(
    { error: "Google Sheets sync is temporarily disabled for Preventive Maintenance." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
