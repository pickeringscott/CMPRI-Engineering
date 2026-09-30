import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { authenticatedUser } from "@/lib/server/request-auth";
import { roleAllows, roleKey } from "@/lib/server/roles";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { jsonObject } from "@/lib/integrations/spreadsheet-input";
import { mergePoolLogBody, PoolLogConflictError, poolLogChanged, poolLogInput, poolLogStatus, poolReadingWarnings, poolClosureReasons, validLogDate } from "@/lib/pool-log";
import { fetchAllPages } from "@/lib/server/paginated-query";

type DatabaseError = { code?: string; message?: string; details?: string | null; hint?: string | null } | null;

function saveFailure(error: DatabaseError) {
  const code = error?.code ?? "";
  const detail = error?.message?.trim() ?? "";
  if (code === "PGRST116") {
    return { status: 409, error: "Someone else saved this pool log while you were saving. Your entries are still on screen; reload this date and save again." };
  }
  if (code === "23505") {
    return { status: 409, error: "A pool log for this date was just created by someone else. Your entries are still on screen; save again to add them to that log." };
  }
  if (code === "PGRST204" || code === "42703" || /column .* (does not exist|could not find)|schema cache/i.test(detail)) {
    return { status: 503, error: "The database is missing the latest pool-log update (apply the pending Supabase migrations in supabase/migrations). Nothing was saved; your entries are still on screen." };
  }
  if ((code === "P0001" || code === "23514" || code === "23502") && detail) {
    return { status: 400, error: `The database did not accept this pool log: ${detail}. Your entries are still on screen.` };
  }
  return { status: 500, error: "Pool readings could not be saved to the database. Your entries are still on screen; try again, and report this if it continues." };
}

export async function GET(request: NextRequest) {
  const auth = await authenticatedUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!roleAllows(auth.profile.role, "view_dashboard")) return NextResponse.json({ error: "Dashboard access is required." }, { status: 403 });
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

  if (request.nextUrl.searchParams.get("history") === "1") {
    const { data: history, error: historyError } = await fetchAllPages((from, to) => admin.from("pool_daily_logs")
      .select("*")
      .eq("hotel_id", HOTEL_ID)
      .eq("pool_facility_id", facility.id)
      .order("log_date", { ascending: false })
      .range(from, to));
    if (historyError) return NextResponse.json({ error: "The complete pool log could not be loaded." }, { status: 503 });
    return NextResponse.json({ facility, facilities, history }, { headers: { "Cache-Control": "private, no-store" } });
  }

  const date = request.nextUrl.searchParams.get("date");
  if (!validLogDate(date)) return NextResponse.json({ error: "Select a valid date." }, { status: 400 });
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
    status: poolLogStatus(log),
    can_edit: roleAllows(auth.profile.role, "operate_integrations"),
    can_edit_saved: roleKey(auth.profile.role) === "system_admin",
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

  if (typeof body.log_date !== "string" || !validLogDate(body.log_date) || typeof body.pool_facility_id !== "string" || !/^[a-f0-9-]{36}$/i.test(body.pool_facility_id)) {
    return NextResponse.json({ error: "Select a valid date and pool." }, { status: 400 });
  }

  const { data: facility, error: facilityError } = await admin.from("pool_facilities")
    .select("id")
    .eq("id", body.pool_facility_id)
    .eq("hotel_id", HOTEL_ID)
    .eq("active", true)
    .maybeSingle();
  if (facilityError) return NextResponse.json({ error: "Pool configuration could not be verified." }, { status: 503 });
  if (!facility) return NextResponse.json({ error: "Select an active pool at CMPRI." }, { status: 400 });

  const name = typeof auth.profile.full_name === "string" ? auth.profile.full_name.trim() : "";
  if (!name) return NextResponse.json({ error: "Your profile needs your name before you can record pool readings." }, { status: 400 });
  const { data: existing, error: readError } = await admin.from("pool_daily_logs")
    .select("*")
    .eq("hotel_id", HOTEL_ID)
    .eq("pool_facility_id", facility.id)
    .eq("log_date", body.log_date)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: "The existing log could not be checked. Nothing was saved." }, { status: 503 });

  const isSystemAdmin = roleKey(auth.profile.role) === "system_admin";
  // A System Administrator correcting the saved log on the web page replaces it as shown.
  // Every other save (later AM/PM samples, voice logging) is merged into the saved log.
  const replace = !!existing && isSystemAdmin && body.edit_mode === "replace";
  if (replace && body.expected_revision !== existing.revision) {
    return NextResponse.json({ error: "This log changed after you opened it. Your entries are still on screen; reload the saved readings before making corrections." }, { status: 409 });
  }

  let row: ReturnType<typeof poolLogInput>;
  try {
    const merged = existing && !replace ? mergePoolLogBody(existing, body, isSystemAdmin) : body;
    row = poolLogInput(merged, existing);
  } catch (error) {
    if (error instanceof PoolLogConflictError) return NextResponse.json({ error: error.message, log: existing }, { status: 403 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid readings." }, { status: 400 });
  }

  if (existing && !poolLogChanged(existing, row)) {
    return NextResponse.json({ log: existing, unchanged: true, status: poolLogStatus(existing) });
  }

  const initials = name.split(/\s+/).map((word) => Array.from(word)[0]).join("");
  const savedInitials = typeof existing?.completed_by_initials === "string" ? existing.completed_by_initials.trim() : "";
  const fields = {
    ...row,
    completed_by_initials: (savedInitials && !savedInitials.split(/\s*\/\s*/).includes(initials)
      ? `${savedInitials} / ${initials}`
      : savedInitials || initials).slice(0, 20),
    updated_by: auth.user.id,
  };
  const mutation = existing
    ? admin.from("pool_daily_logs").update(fields).eq("hotel_id", HOTEL_ID).eq("id", existing.id).eq("revision", existing.revision)
    : admin.from("pool_daily_logs").insert({ ...fields, hotel_id: HOTEL_ID, created_by: auth.user.id });
  const { data: log, error: saveError } = await mutation.select("*").single();
  if (saveError || !log) {
    console.error("Pool log save failed", { code: saveError?.code, message: saveError?.message, details: saveError?.details, hint: saveError?.hint });
    const failure = saveFailure(saveError);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
  const closureReasons = poolClosureReasons(log);
  return NextResponse.json({
    log,
    status: poolLogStatus(log),
    closure_required: closureReasons.length > 0 || log.closure_condition === true,
    closure_reasons: closureReasons,
    warnings: poolReadingWarnings(log),
  });
}
