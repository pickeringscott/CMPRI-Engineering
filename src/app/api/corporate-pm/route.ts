import { NextRequest, NextResponse } from "next/server";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { corporatePmUpdate, jsonObject, matchesWritablePmCell } from "@/lib/integrations/spreadsheet-input";
import { integrationErrorStatus, isIntegrationsSafeMode, requireIntegrationConfig, safeModeBlocked } from "@/lib/server/integrations-safe-mode";

async function readCorporatePm(action: "read" | "roompm", params: Record<string, string> = {}) {
  const { url: apiUrl, apiKey } = requireIntegrationConfig(
    "Corporate PM",
    process.env.CMPRI_CORPORATE_PM_API_URL,
    process.env.CMPRI_CORPORATE_PM_API_KEY,
    "CMPRI_CORPORATE_PM_API_URL",
    "CMPRI_CORPORATE_PM_API_KEY",
  );
  const url = new URL(apiUrl);
  url.searchParams.set("action", action);
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);

  const response = await fetch(url, { cache: "no-store", redirect: "follow" });
  const text = await response.text();
  let result: Record<string, unknown>;
  try { result = JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(`Corporate PM API returned an unreadable response (${response.status}).`); }
  if (!response.ok || result.ok !== true) throw new Error(String(result.error || `Corporate PM request failed (${response.status}).`));
  return result;
}

async function writeCorporatePm(payload: Record<string, unknown>) {
  if (isIntegrationsSafeMode()) {
    return safeModeBlocked("Corporate PM", String(payload.action || "write"));
  }
  const { url, apiKey } = requireIntegrationConfig(
    "Corporate PM",
    process.env.CMPRI_CORPORATE_PM_API_URL,
    process.env.CMPRI_CORPORATE_PM_API_KEY,
    "CMPRI_CORPORATE_PM_API_URL",
    "CMPRI_CORPORATE_PM_API_KEY",
  );
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, key: apiKey }),
    cache: "no-store",
    redirect: "follow",
  });
  const text = await response.text();
  let result: Record<string, unknown>;
  try { result = JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(`Corporate PM API returned an unreadable response (${response.status}).`); }
  if (!response.ok || result.ok !== true) throw new Error(String(result.error || `Corporate PM request failed (${response.status}).`));
  return result;
}

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!allows(auth.principal, "view_dashboard")) return NextResponse.json({ error: "Dashboard access is required." }, { status: 403 });
  try {
    const { searchParams } = new URL(request.url);
    const room = (searchParams.get("room") || "").trim();
    if (room) {
      const result = await readCorporatePm("roompm", { room });
      return NextResponse.json({ ...result, can_edit: allows(auth.principal, "operate_integrations"), safeMode: isIntegrationsSafeMode() }, { headers: { "Cache-Control": "no-store" } });
    }
    const sheet = (searchParams.get("sheet") || "").trim().toUpperCase();
    const result = await readCorporatePm("read", sheet ? { sheet } : {});
    return NextResponse.json({ ...result, can_edit: allows(auth.principal, "operate_integrations"), safeMode: isIntegrationsSafeMode() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: integrationErrorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!allows(auth.principal, "operate_integrations")) return NextResponse.json({ error: "Your account has read-only access to Corporate PM." }, { status: 403 });
  const payload = corporatePmUpdate(await jsonObject(request));
  if (!payload) return NextResponse.json({ error: "Supply a valid PM action, target and correctly typed values." }, { status: 400 });
  try {
    if (payload.action === "setcheckbox") {
      const snapshot = await readCorporatePm("read", { sheet: String(payload.sheet) });
      if (!matchesWritablePmCell(snapshot, payload)) return NextResponse.json({ error: "The target sheet/cell could not be verified as an editable boolean value. Refresh the checklist." }, { status: 409 });
    }

    const result = await writeCorporatePm(payload);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: integrationErrorStatus(error) });
  }
}
