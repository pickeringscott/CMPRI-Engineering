import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { authenticatedUser } from "@/lib/server/request-auth";
import { roleAllows } from "@/lib/server/roles";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { jsonObject } from "@/lib/integrations/spreadsheet-input";
import { poolLogInput, validLogDate } from "@/lib/pool-log";

export async function GET(request: NextRequest) {
  const auth = await authenticatedUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!roleAllows(auth.profile.role, "view_dashboard")) return NextResponse.json({ error: "Dashboard access is required." }, { status: 403 });
  const date = request.nextUrl.searchParams.get("date");
  if (!validLogDate(date)) return NextResponse.json({ error: "Select a valid date." }, { status: 400 });

  const admin = auth.admin ?? createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "CMPRI database configuration is unavailable." }, { status: 503 });

  const { data: facilities, error } = await admin.from("pool_facilities")
    .select("id, facility_name, pool_name, city, sanitizer, volume_gallons")
    .eq("hotel_id", HOTEL_ID)
    .eq("active", true)
    .order("pool_name");
  if (error) return NextResponse.json({ error: "Pool configuration could not be loaded." }, { status: 503 });
  const requested = request.nextUrl.searchParams.get("facility");
  const facility = requested ? facilities?.find((item) => item.id === requested) : facilities?.[0];
  if (!facility) return NextResponse.json({ error: "No matching active pool is configured." }, { status: 404 });

  const { data: log, error: logError } = await admin.from("pool_daily_logs")
    .select("*")
    .eq("hotel_id", HOTEL_ID)
    .eq("pool_facility_id", facility.id)
    .eq("log_date", date)
    .maybeSingle();
  if (logError) return NextResponse.json({ error: "The daily log could not be loaded. No changes were made." }, { status: 503 });
  return NextResponse.json({
    facility,
    facilities,
    log,
    date,
    can_edit: roleAllows(auth.profile.role, "operate_integrations"),
    operator: auth.profile.full_name || "",
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = await authenticatedUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!roleAllows(auth.profile.role, "operate_integrations")) return NextResponse.json({ error: "Engineering access is required to save pool readings." }, { status: 403 });
  const body = await jsonObject(request);
  if (!body) return NextResponse.json({ error: "A JSON object is required." }, { status: 400 });

  const admin = auth.admin ?? createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "CMPRI database configuration is unavailable." }, { status: 503 });

  let row: ReturnType<typeof poolLogInput>;
  try { row = poolLogInput(body); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid readings." }, { status: 400 }); }

  const { data: facility, error: facilityError } = await admin.from("pool_facilities")
    .select("id")
    .eq("id", row.pool_facility_id)
    .eq("hotel_id", HOTEL_ID)
    .eq("active", true)
    .maybeSingle();
  if (facilityError) return NextResponse.json({ error: "Pool configuration could not be verified." }, { status: 503 });
  if (!facility) return NextResponse.json({ error: "Select an active pool at CMPRI." }, { status: 400 });

  const name = typeof auth.profile.full_name === "string" ? auth.profile.full_name.trim() : "";
  if (!name) return NextResponse.json({ error: "Your profile needs your name before you can record pool readings." }, { status: 400 });
  const { data: existing, error: readError } = await admin.from("pool_daily_logs")
    .select("id, revision")
    .eq("hotel_id", HOTEL_ID)
    .eq("pool_facility_id", facility.id)
    .eq("log_date", row.log_date)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: "The existing log could not be checked. Nothing was saved." }, { status: 503 });

  if (existing && (body.expected_revision !== existing.revision || !Number.isSafeInteger(body.expected_revision))) {
    return NextResponse.json({ error: "This log changed. Keep your entries and reload the saved readings before combining changes." }, { status: 409 });
  }
  if (!existing && body.expected_revision != null) {
    return NextResponse.json({
      error: "The saved log is no longer available, so nothing was saved. Keep your readings, reload this same date and pool, and if the log is still empty, save again as a new log.",
    }, { status: 409 });
  }

  const fields = {
    ...row,
    completed_by_initials: name.split(/\s+/).map((word) => Array.from(word)[0]).join("").slice(0, 20),
    updated_by: auth.user.id,
  };
  const mutation = existing
    ? admin.from("pool_daily_logs").update(fields).eq("hotel_id", HOTEL_ID).eq("id", existing.id).eq("revision", existing.revision)
    : admin.from("pool_daily_logs").insert({ ...fields, hotel_id: HOTEL_ID, created_by: auth.user.id });
  const { data: log, error: saveError } = await mutation.select("*").single();
  if (saveError || !log) {
    return NextResponse.json({ error: "Pool readings could not be saved because the record changed or the database rejected the update. Your entries are still available." }, { status: 409 });
  }
  return NextResponse.json({ log });
}
