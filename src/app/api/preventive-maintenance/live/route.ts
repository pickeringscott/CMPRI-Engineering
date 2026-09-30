import { NextRequest, NextResponse } from "next/server";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { integrationErrorStatus } from "@/lib/server/integrations-safe-mode";
import { readLivePmWeek } from "@/lib/server/live-pm";

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

  try {
    const workbook = await readLivePmWeek(week);
    return NextResponse.json(workbook, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Live PM workbook could not be loaded." },
      { status: integrationErrorStatus(error) },
    );
  }
}
