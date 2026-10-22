import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { authenticatedUser } from "@/lib/server/request-auth";
import { receivesPoolClosedNotifications, roleAllows, roleKey } from "@/lib/server/roles";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { jsonObject } from "@/lib/integrations/spreadsheet-input";
import { mergePoolLogBody, PoolLogConflictError, poolLogChanged, poolLogInput, poolLogStatus, poolReadingWarnings, poolCurrentClosureReasons, validLogDate } from "@/lib/pool-log";
import { fetchAllPages } from "@/lib/server/paginated-query";
import { dispatchWebPushNotifications } from "@/lib/notifications/web-push";

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
  if (!roleAllows(auth.profile.role, "view_dashboard") && !roleAllows(auth.profile.role, "view_pool_log")) {
    return NextResponse.json({ error: "Pool-log access is required." }, { status: 403 });
  }
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
  const retests: Record<string, unknown>[] = [];
  if (log?.retest_submission) {
    const { data: snapshots, error: historyError } = await fetchAllPages((from, to) => admin.from("cmpri_pool_log_history")
      .select("actor_id, recorded_at, snapshot")
      .eq("hotel_id", HOTEL_ID).eq("pool_log_id", log.id)
      .order("recorded_at", { ascending: true }).order("id", { ascending: true }).range(from, to));
    if (historyError) return NextResponse.json({ error: "The recorded retest history could not be loaded." }, { status: 503 });
    const seen = new Set<string>();
    // Revisions provide ordering even when several audit snapshots share a timestamp.
    const ordered = [...(snapshots || [])].sort((a, b) =>
      Number((a.snapshot as Record<string, unknown>)?.revision ?? 0) - Number((b.snapshot as Record<string, unknown>)?.revision ?? 0));
    for (const entry of ordered) {
      const snapshot = entry.snapshot as Record<string, unknown> | null;
      const retest = snapshot?.retest_submission as Record<string, unknown> | null;
      if (!retest || typeof retest.id !== "string" || seen.has(retest.id)) continue;
      seen.add(retest.id);
      retests.push({ ...retest, recorded_at: entry.recorded_at, actor_id: entry.actor_id, revision: snapshot?.revision });
    }
  }
  return NextResponse.json({
    facility,
    facilities,
    log,
    retests,
    date,
    status: poolLogStatus(log),
    can_edit: roleAllows(auth.profile.role, "operate_pool_log"),
    can_edit_saved: roleKey(auth.profile.role) === "system_admin",
    operator: auth.profile.full_name || "",
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = await authenticatedUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!roleAllows(auth.profile.role, "operate_pool_log")) return NextResponse.json({ error: "Pool-log operating permission is required to save readings." }, { status: 403 });
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
  if ((replace || (body.retest != null && body.expected_revision != null)) && body.expected_revision !== existing?.revision) {
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
  const closureReasons = poolCurrentClosureReasons(log);
  const wasClosed = !!existing && (existing.closure_condition === true || poolCurrentClosureReasons(existing).length > 0);
  const isClosed = closureReasons.length > 0 || log.closure_condition === true;
  // In-app recipients and their deduplicated event are committed by the log trigger.
  const notificationsRecorded = true;
  if (!wasClosed && isClosed) {
    const {data: profiles} = await admin.from("profiles").select("id,role,secondary_roles,active").eq("active",true);
    const eligible=(profiles||[]).filter(receivesPoolClosedNotifications);
    const {data:memberships}=eligible.length?await admin.from("hotel_members").select("user_id").eq("hotel_id",HOTEL_ID).eq("active",true).in("user_id",eligible.map(p=>p.id)):{data:[]};
    const activeMembers=new Set((memberships||[]).map(m=>m.user_id));
    for (const profile of eligible.filter(p=>activeMembers.has(p.id))) {
      const {data: notice} = await admin.from("cmpri_dashboard_notifications").select("notification_key,message,target_path")
        .eq("hotel_id",HOTEL_ID).eq("recipient_user_id",profile.id).like("notification_key",`pool-closed:status:${facility.id}:%`).order("recorded_at",{ascending:false}).limit(1);
      if(notice?.[0]) { try { await dispatchWebPushNotifications(admin,profile.id,profile,[{id:notice[0].notification_key,message:notice[0].message,target_path:notice[0].target_path}]); } catch(error) { console.error("Pool notification recorded; phone delivery deferred",error); } }
    }
  }
  return NextResponse.json({
    log,
    status: poolLogStatus(log),
    closure_required: closureReasons.length > 0 || log.closure_condition === true,
    closure_reasons: closureReasons,
    warnings: poolReadingWarnings(log),
    notifications_recorded: notificationsRecorded,
  });
}
