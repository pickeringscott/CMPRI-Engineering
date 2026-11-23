import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { canOpenGss } from "@/lib/dashboard/menu-access";
import { allows } from "@/lib/server/access";
import { requireUserAttempt } from "@/lib/server/auth";
import { createPoolReport, reportMonths, type ReportLog } from "@/lib/pool-report";
import { createPmWeeklyTransferCsv, type PmTransferEntry } from "@/lib/pm/weekly-transfer";
import { verifiedGssReports } from "@/app/engineering/gss/gss-reports";
import { latestRankings } from "@/app/engineering/gss/gss-latest-rankings";

const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const poolQuery = z.object({ facility: z.string().uuid(), start: z.string().trim().max(5), end: z.string().trim().max(5) }).strict();
const GSS_METRICS = ["Intent to Recommend (Property)", "Elite Appreciation", "Cleanliness", "Staff Service", "Maintenance and Upkeep", "Food and Beverage"];

/** The same saved history and official form used by the Pool Log print control. */
export async function prepareNativePoolReport(request: NextRequest): Promise<Response> {
  const entries = [...request.nextUrl.searchParams];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    return NextResponse.json({ error: "Supply one facility, start month and end month." }, { status: 400, headers: HEADERS });
  }
  const parsed = poolQuery.safeParse(Object.fromEntries(entries));
  if (!parsed.success) return NextResponse.json({ error: "Choose the actual pool facility UUID and start/end months in MM/YY format." }, { status: 400, headers: HEADERS });
  let months: string[];
  try { months = reportMonths(parsed.data.start, parsed.data.end); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Choose a valid monthly report range." }, { status: 400, headers: HEADERS }); }

  const url = new URL("/api/pool-log", request.url);
  url.searchParams.set("history", "1");
  url.searchParams.set("facility", parsed.data.facility);
  const authorization = request.headers.get("authorization");
  // The original Pool Log reader enforces its role, facility and property rules
  // and loads every history page. Do not accept model-supplied report rows.
  const { GET } = await import("@/app/api/pool-log/route");
  const result = await GET(new NextRequest(url, { method: "GET", headers: authorization ? { authorization } : {}, signal: request.signal }));
  if (!result.ok) return result;
  const data = await result.json() as { facility?: { id?: string }; history?: ReportLog[] };
  if (data.facility?.id !== parsed.data.facility || !Array.isArray(data.history)
    || data.history.some(log => !log || typeof log !== "object" || typeof log.log_date !== "string")) {
    return NextResponse.json({ error: "The complete saved history for this pool could not be verified." }, { status: 503, headers: HEADERS });
  }
  try {
    request.signal.throwIfAborted();
    const template = await readFile(join(process.cwd(), "public/forms/swimming-facility-daily-operational-report.pdf"));
    const selected = new Set(months);
    const bytes = await createPoolReport(new Uint8Array(template).buffer, months, data.history.filter(log => selected.has(log.log_date.slice(0, 7))));
    request.signal.throwIfAborted();
    return new Response(new Uint8Array(bytes), { headers: {
      ...HEADERS, "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Residence-Inn-Pool-${months[0]}-to-${months.at(-1)}.pdf"`,
    } });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return NextResponse.json({ error: "The official pool report could not be prepared from the saved readings." }, { status: 503, headers: HEADERS });
  }
}

/** Source-owned, dated snapshots displayed by GSS; never label these as a new mailbox read. */
export async function readNativeGssReports(request: NextRequest): Promise<Response> {
  const auth = await requireUserAttempt(request);
  if (!auth.ok) return NextResponse.json({ error: "Sign in is required." }, { status: 401, headers: HEADERS });
  const permitted = auth.mcp ? allows(auth.principal, "view_engineering_operations") : canOpenGss(auth.principal.profile);
  if (!permitted) return NextResponse.json({ error: "GSS Reports access is required." }, { status: 403, headers: HEADERS });
  return NextResponse.json({
    source: "CMPRI GSS Reports · verified source transcriptions",
    verifiedDate: verifiedGssReports[0]?.date ?? null,
    metrics: GSS_METRICS,
    reports: verifiedGssReports,
    rankings: { date: verifiedGssReports[0]?.date ?? null, periods: latestRankings },
    scoreUnits: "Source percentages; scores follow the metrics array order.",
    instruction: "These are the exact verified, dated scorecard and ranking snapshots shown in CMPRI, not a live mailbox refresh. Preserve each source reporting period, sample size, source trend and source color. Wave to Date is not week to date. Do not aggregate snapshots or infer comparisons across reporting-period resets. Use gss.read for the separately fetched latest source report; it may be newer than these verified transcriptions.",
  }, { headers: HEADERS });
}

/** Only persisted PM records; browser forms and the local task queue are not part of this request. */
export async function exportNativePmWeeklyCsv(request: NextRequest): Promise<Response> {
  const pairs = [...request.nextUrl.searchParams];
  const week = request.nextUrl.searchParams.get("week") || "";
  const date = new Date(`${week}T12:00:00Z`);
  if (pairs.length !== 1 || pairs[0][0] !== "week" || !/^\d{4}-\d{2}-\d{2}$/.test(week)
    || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== week || date.getUTCDay() !== 1) {
    return NextResponse.json({ error: "Select a saved PM week beginning on Monday (YYYY-MM-DD)." }, { status: 400, headers: HEADERS });
  }
  const url = new URL("/api/preventive-maintenance", request.url);
  url.searchParams.set("week", week);
  const authorization = request.headers.get("authorization");
  const { GET } = await import("@/app/api/preventive-maintenance/route");
  const response = await GET(new NextRequest(url, { method: "GET", headers: authorization ? { authorization } : {}, signal: request.signal }));
  if (!response.ok) return response;
  const data = await response.json() as { week?: string; entries?: PmTransferEntry[] };
  if (data.week !== week || !Array.isArray(data.entries) || data.entries.some(entry => !entry || typeof entry !== "object"
    || typeof entry.template_id !== "string" || typeof entry.period_start !== "string" || typeof entry.scope_key !== "string")) {
    return NextResponse.json({ error: "The saved PM records for this week could not be verified." }, { status: 503, headers: HEADERS });
  }
  request.signal.throwIfAborted();
  const csv = createPmWeeklyTransferCsv({ weekStart: week, entries: data.entries, spreadsheetSyncEnabled: false });
  return new Response(csv, { headers: {
    ...HEADERS, "Content-Type": "text/csv;charset=utf-8",
    "Content-Disposition": `attachment; filename="cmpri-pm-${week}-saved-transfer.csv"`,
    "X-CMPRI-Export-Source": "Saved PM records only; unsaved browser forms and queued changes are excluded.",
  } });
}
