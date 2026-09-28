"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { roleDisplayName } from "@/lib/account-display";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import { frontDeskSessionId, readFrontDeskEmployeeName, saveFrontDeskEmployeeName, validEmployeeFullName } from "@/lib/auth/front-desk-session";

type Profile = { id: string; email: string | null; full_name: string | null; role: string | null };
type Preferences = {
  language: "en" | "es";
  appearance: "light" | "dark";
  notification_mode: "in_app" | "email" | "both";
  notifications: { new_work_orders: boolean; status_changes: boolean; mentions: boolean };
};
type Payload = { profile: Profile; preferences: Preferences; profile_settings_available: boolean; manage_profile_first_login_complete?: boolean; can_manage_users: boolean; personal_ai: { connected: boolean; status: string; message: string }; warning?: string };

function applyPreferences(preferences: Preferences) {
  window.localStorage.setItem("cmpri:work-order-language", preferences.language);
  window.localStorage.setItem("cmpri:appearance", preferences.appearance);
  document.documentElement.lang = preferences.language;
  document.documentElement.dataset.theme = preferences.appearance;
  const message = { type: "cmpri-profile-preferences-updated", preferences };
  window.parent.postMessage(message, window.location.origin);
  if (window.top !== window.parent) window.top?.postMessage(message, window.location.origin);
}

export default function ProfilePage() {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [name, setName] = useState("");
  const [frontDeskEmployeeName, setFrontDeskEmployeeName] = useState("");
  const [frontDeskSessionKey, setFrontDeskSessionKey] = useState("");
  const [frontDeskSessionConfirmed, setFrontDeskSessionConfirmed] = useState(false);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const isSpanish = preferences?.language === "es";
  const isHousekeeping = roleDisplayName(data?.profile.role || "") === "Lead Housekeeper";
  const isFrontDesk = roleDisplayName(data?.profile.role || "") === "Front Desk";
  const firstLoginConfirmation = isFrontDesk
    ? !frontDeskSessionConfirmed
    : data?.manage_profile_first_login_complete === false;
  const profileDashboardHref = ["Front Desk", "Lead Housekeeper"].includes(roleDisplayName(data?.profile.role || ""))
    ? "/work-orders"
    : "/engineering";
  const tx = (english: string, spanish: string) => isSpanish ? spanish : english;

  async function headers() {
    const session = await getValidSession();
    if (!session?.access_token) throw new Error("Sign in again to manage your profile.");
    return { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
  }

  async function load() {
    setLoading(true);
    setMessage("");
    setData(null);
    const response = await fetch("/api/profile", { headers: await headers(), cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Profile could not be loaded.");
    const result = payload as Payload;
    setData(result);
    setName(result.profile.full_name || "");
    if (roleDisplayName(result.profile.role || "") === "Front Desk") {
      const authSession = await getValidSession();
      const sessionId = frontDeskSessionId(authSession?.access_token);
      setFrontDeskSessionKey(sessionId);
      const sessionName = readFrontDeskEmployeeName(window.sessionStorage, result.profile.id, sessionId);
      setFrontDeskEmployeeName(sessionName);
      setFrontDeskSessionConfirmed(validEmployeeFullName(sessionName));
    }
    setPreferences(result.preferences);
    if (result.profile_settings_available !== false) applyPreferences(result.preferences);
    setMessage(result.warning || (result.profile_settings_available === false
      ? "Saved personal preferences are unavailable until the profile-preferences migration is applied."
      : ""));
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => {
    void Promise.resolve().then(load).catch((error) => setMessage(error instanceof Error ? error.message : "Profile could not be loaded.")).finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!preferences) return;
    if (isFrontDesk && !validEmployeeFullName(frontDeskEmployeeName)) {
      setMessage("Enter your full name, including first and last name, for this session.");
      return;
    }
    if (isFrontDesk && !frontDeskSessionKey) {
      setMessage("The verified Front Desk session could not be identified. Sign in again before confirming this profile.");
      return;
    }
    if (!isFrontDesk && !name.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: await headers(),
        body: JSON.stringify({
          ...(isFrontDesk ? {} : { full_name: name }),
          preferences,
          ...(firstLoginConfirmation ? { complete_manage_profile: true } : {}),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Profile could not be saved.");
      if (isFrontDesk && !saveFrontDeskEmployeeName(window.sessionStorage, data!.profile.id, frontDeskSessionKey, frontDeskEmployeeName)) {
        throw new Error("Profile settings were saved, but the employee name could not be retained for this session. Keep this page open and retry.");
      }
      if (isFrontDesk) {
        const nameUpdate = {
          type: "cmpri-frontdesk-session-name-updated",
          userId: data!.profile.id,
          sessionId: frontDeskSessionKey,
          name: frontDeskEmployeeName.trim().replace(/\s+/g, " "),
        };
        window.parent.postMessage(nameUpdate, window.location.origin);
        if (window.top !== window.parent) window.top?.postMessage(nameUpdate, window.location.origin);
      }
      if (payload.profile_settings_available !== false) applyPreferences(payload.preferences);
      setMessage(payload.warning || (isFrontDesk && firstLoginConfirmation
        ? "Your name and language are confirmed for this Front Desk session."
        : firstLoginConfirmation
          ? "Profile confirmed. You can manage it here again any time."
          : tx("Profile and preferences saved.", "Perfil y preferencias guardados.")));
      setPreferences(payload.preferences);
      setData((current) => current ? { ...current, profile: payload.profile, preferences: payload.preferences, profile_settings_available: payload.profile_settings_available !== false, manage_profile_first_login_complete: payload.manage_profile_first_login_complete !== false, warning: payload.warning } : current);
      if (isFrontDesk) setFrontDeskSessionConfirmed(true);
      if (firstLoginConfirmation) {
        const requested = new URLSearchParams(window.location.search).get("returnTo");
        const fallback = profileDashboardHref;
        const returnTo = requested === "/work-orders" || requested === "/technician" || requested === "/engineering" ? requested : fallback;
        router.replace(returnTo);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profile could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function setPersonalAiConnection(action: "connect" | "disconnect") {
    if (data?.profile_settings_available === false) return;
    setAiBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: await headers(),
        body: JSON.stringify({ personal_ai_action: action }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Personal AI connection could not be updated.");
      setData((current) => current ? { ...current, personal_ai: payload.personal_ai } : current);
      setMessage(action === "connect" ? tx("OpenAI connection enabled for this user.", "Conexión de OpenAI habilitada para este usuario.") : tx("OpenAI connection disabled for this user.", "Conexión de OpenAI deshabilitada para este usuario."));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Personal AI connection could not be updated.");
    } finally {
      setAiBusy(false);
    }
  }

  if (!data || !preferences) return (
    <main className="min-h-screen bg-slate-950 p-6 text-white">
      <div className="mx-auto max-w-xl rounded-xl border border-slate-700 bg-slate-900 p-5" role={message ? "alert" : undefined}>
        <h1 className="text-xl font-bold">{message ? "Manage Profile" : "Loading profile…"}</h1>
        {message && <p className="mt-2 text-sm text-slate-300">{message}</p>}
        {message && <button type="button" onClick={() => void load().catch((error) => setMessage(error instanceof Error ? error.message : "Profile could not be loaded.")).finally(() => setLoading(false))} disabled={loading} className="mt-4 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{loading ? "Retrying…" : "Retry"}</button>}
      </div>
    </main>
  );

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="flex items-center justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">{tx("CMPRI Account", "Cuenta CMPRI")}</p>
            <h1 className="mt-1 text-3xl font-bold">{tx("Manage Profile", "Administrar perfil")}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" disabled={aiBusy || data.profile_settings_available === false} onClick={() => void setPersonalAiConnection(data.personal_ai.connected ? "disconnect" : "connect")} className={`rounded-lg border px-4 py-2 text-sm font-bold disabled:opacity-50 ${data.personal_ai.connected ? "border-red-500/50 text-red-200 hover:bg-red-950/30" : "border-sky-500/50 bg-sky-950/30 text-sky-100 hover:bg-sky-900/40"}`}>
              {aiBusy ? tx("Updating…", "Actualizando…") : data.personal_ai.connected ? "Disconnect AI" : "Connect AI"}
            </button>
            <ModalDashboardLink href={profileDashboardHref} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">{tx("Dashboard", "Panel")}</ModalDashboardLink>
          </div>
        </div>

        {message && <div role="status" className="mt-5 rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm">{message}</div>}

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-xl font-bold">{tx("Personal Preferences", "Preferencias personales")}</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm text-slate-300">{tx("Language", "Idioma")}<select value={preferences.language} disabled={data.profile_settings_available === false} onChange={(event) => setPreferences({ ...preferences, language: event.target.value as Preferences["language"] })} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white disabled:opacity-50"><option value="en">English</option><option value="es">Español</option></select></label>
            <label className="grid gap-1 text-sm text-slate-300">{tx("Appearance", "Apariencia")}<select value={preferences.appearance} disabled={data.profile_settings_available === false} onChange={(event) => setPreferences({ ...preferences, appearance: event.target.value as Preferences["appearance"] })} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white disabled:opacity-50"><option value="dark">{tx("Dark", "Oscuro")}</option><option value="light">{tx("Light", "Claro")}</option></select></label>
          </div>
          {!isHousekeeping && <div className="mt-4 grid gap-1 text-sm text-slate-300">
            <label>{tx("Notification delivery", "Entrega de notificaciones")}<select value={preferences.notification_mode} disabled={data.profile_settings_available === false} onChange={(event) => setPreferences({ ...preferences, notification_mode: event.target.value as Preferences["notification_mode"] })} className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-white disabled:opacity-50"><option value="in_app">{tx("In-app notifications", "Notificaciones en la aplicación")}</option><option value="email">{tx("Email notifications", "Notificaciones por correo")}</option><option value="both">{tx("Both", "Ambas")}</option></select></label>
          </div>}
          {!isHousekeeping && <fieldset disabled={data.profile_settings_available === false} className="mt-4 grid gap-2 text-sm text-slate-300 disabled:opacity-50">
            <legend className="mb-2 font-semibold">{tx("Notify me about", "Notificarme sobre")}</legend>
            {([["new_work_orders", "New work orders", "Nuevas órdenes de trabajo"], ["status_changes", "Status changes", "Cambios de estado"], ["mentions", "Ticket mentions", "Menciones en tickets"]] as const).map(([key, english, spanish]) => (
              <label key={key} className="flex min-h-10 items-center gap-3">
                <input type="checkbox" checked={preferences.notifications[key]} onChange={(event) => setPreferences({ ...preferences, notifications: { ...preferences.notifications, [key]: event.target.checked } })} className="size-4 accent-sky-500" />
                {tx(english, spanish)}
              </label>
            ))}
          </fieldset>}
        </section>

        <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-xl font-bold">{tx("Profile", "Perfil")}</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm text-slate-300">{isFrontDesk ? "Current employee full name" : tx("Display name", "Nombre para mostrar")}<input required={isFrontDesk} maxLength={isFrontDesk ? 80 : 200} autoComplete={isFrontDesk ? "name" : "name"} value={isFrontDesk ? frontDeskEmployeeName : name} onChange={(event) => isFrontDesk ? setFrontDeskEmployeeName(event.target.value) : setName(event.target.value)} disabled={busy} placeholder={isFrontDesk ? "First and last name" : undefined} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white" />{isFrontDesk && <span className="text-xs text-slate-400">This name is stored only for the current verified Front Desk session and is saved with each ticket.</span>}</label>
            <label className="grid gap-1 text-sm text-slate-300">{tx("Sign-in email", "Correo de inicio de sesión")}<input value={data.profile.email || ""} readOnly className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-slate-400" /></label>
            <label className="grid gap-1 text-sm text-slate-300 sm:col-span-2">{tx("Job Title / Role", "Puesto / Rol")}<input value={isHousekeeping ? "Housekeeping" : roleDisplayName(data.profile.role || "Unknown")} readOnly className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-slate-400" /></label>
          </div>
        </section>

        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <Link href="/feedback?route=%2Fprofile" className="rounded-lg border border-amber-500/50 bg-amber-950/20 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-900/30">Report a Problem / Suggestion</Link>
          {data.can_manage_users && <Link href="/management/users" className="rounded-lg border border-sky-500/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">{tx("User Management", "Administración de usuarios")}</Link>}
          <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-blue-700 px-5 py-2 font-bold text-white hover:bg-blue-600 disabled:opacity-50">{busy ? tx("Saving…", "Guardando…") : firstLoginConfirmation ? (isFrontDesk ? "Confirm Front Desk Session" : "Confirm Profile") : tx("Save Profile", "Guardar perfil")}</button>
        </div>
      </div>
    </main>
  );
}
