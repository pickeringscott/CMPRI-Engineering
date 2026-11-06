import { NextRequest, NextResponse } from "next/server";
import { requireCapability, requireUser } from "@/lib/server/auth";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { fetchOperationalMessages } from "@/lib/integrations/email-provider";
import { saveOperationalRecord } from "@/lib/server/email-ingest";
import { isIntegrationsSafeMode } from "@/lib/server/integrations-safe-mode";

async function authorized(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const bearer = request.headers.get("authorization") || "";
  if (cronSecret && bearer === `Bearer ${cronSecret}`) return true;
  return Boolean(await requireCapability(request, "operate_integrations"));
}

async function scan(request: NextRequest) {
  if (!(await authorized(request))) {
    const auth = await requireUser(request);
    if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
    return NextResponse.json({ error: "Email integration access is required." }, { status: 403 });
  }
  if (isIntegrationsSafeMode()) {
    return NextResponse.json({
      configured: false,
      safeMode: true,
      blocked: true,
      error: "Safe mode is on: mailbox scan was NOT sent to an external provider.",
    }, { status: 503 });
  }
  // Prevent manual/legacy scans racing the push worker's serialized imports.
  if(process.env.CMPRI_EMAIL_PUSH_ENABLED === "true")return NextResponse.json({error:"Email push owns mailbox ingestion. Check push status; disable push explicitly before manual recovery."},{status:409});
  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Supabase service configuration is missing." }, { status: 503 });
  try {
    const { provider, messages, truncated } = await fetchOperationalMessages();
    if (!provider) return NextResponse.json({ configured: false, error: "Configure a read-only Microsoft 365 or Gmail mailbox before scanning." }, { status: 503 });
    let saved = 0, duplicates = 0, skipped = 0;
    const categories: Record<string, number> = {};
    const errors: string[] = [];
    for (const message of messages) {
      try {
        const result = await saveOperationalRecord(admin, message);
        if (result.saved) {
          saved++;
          if (result.category) categories[result.category] = (categories[result.category] || 0) + 1;
        } else if (result.duplicate) duplicates++;
        else skipped++;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Email import failed.");
        if (errors.length >= 10) break;
      }
    }
    const complete = !truncated && errors.length === 0;
    return NextResponse.json({ configured: true, provider, complete, truncated, found: messages.length, saved, duplicates, skipped, categories, errors }, { status: errors.length ? 502 : 200 });
  } catch (error) {
    return NextResponse.json({ configured: false, error: error instanceof Error ? error.message : "Mailbox scan failed." }, { status: 503 });
  }
}

// GET is reserved for the scheduler; manual writes require POST.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return scan(request);
}

export async function POST(request: NextRequest) {
  return scan(request);
}
