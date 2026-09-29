"use client";

import { useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { roleDisplayName } from "@/lib/account-display";
import { signOutDevice } from "@/lib/supabase/client";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import ModalNavigationButton from "@/components/ModalNavigationButton";
import useEmbeddedModal from "@/components/use-embedded-modal";

type Profile = { id: string; email: string | null; full_name: string | null; role: string | null };
type Preferences = {
  language: "en" | "es";
  appearance: "light" | "dark";
  notification_mode: "in_app" | "email" | "both";
  notifications: { new_work_orders: boolean; status_changes: boolean; mentions: boolean };
};
type ChatGptConnection = { connected: boolean; status: "active" | "disconnected"; access: "read_write" | "read_only" | "disconnected"; provider: string; endpoint: string; message: string } | null;
type Payload = { profile: Profile; preferences: Preferences; profile_settings_available: boolean; can_manage_users: boolean; chatgpt_connection: ChatGptConnection; warning?: string };

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
  const embedded = useEmbeddedModal();
  const [data, setData] = useState<Payload | null>(null);
  const [name, setName] = useState("");
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const isSpanish = preferences?.language === "es";
  const isHousekeeping = roleDisplayName(data?.profile.role || "") === "Lead Housekeeper";
  const isSubmitOnlyProfile = ["Front Desk", "Lead Housekeeper"].includes(roleDisplayName(data?.profile.role || ""));
  const profileDashboardHref = isSubmitOnlyProfile
    ? "/work-orders"
    : "/engineering";
  const tx = (english: string, spanish: string) => isSpanish ? spanish : english;

  async function signOut() {
    try {
      await signOutDevice();
      if (embedded && window.parent !== window) {
        window.parent.postMessage({ type: "cmpri-modal-sign-out" }, window.location.origin);
      } else {
        window.location.replace("/");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not sign out.");
    }
  }

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
    setPreferences(result.preferences);
    if (result.profile_settings_available !== false) applyPreferences(result.preferences);
    setMessage(result.warning || (result.profile_settings_available === false
      ? "Saved personal preferences are unavailable until the profile-preferences migration is applied."
      : ""));
  }

  useEffect(() => {
    void Promise.resolve().then(load).catch((error) => setMessage(error instanceof Error ? error.message : "Profile could not be loaded.")).finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleAiConnectionUpdate = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "cmpri-profile-ai-updated") return;
      void load().catch((error) => setMessage(error instanceof Error ? error.message : "AI connection status could not be refreshed."));
    };
    window.addEventListener("message", handleAiConnectionUpdate);
    return () => window.removeEventListener("message", handleAiConnectionUpdate);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!preferences || !name.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: await headers(),
        body: JSON.stringify({ full_name: name, preferences }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Profile could not be saved.");
      if (payload.profile_settings_available !== false) applyPreferences(payload.preferences);
      setMessage(payload.warning || tx("Profile and preferences saved.", "Perfil y preferencias guardados."));
      setPreferences(payload.preferences);
      setData((current) => current ? { ...current, profile: payload.profile, preferences: payload.preferences, profile_settings_available: payload.profile_settings_available !== false, warning: payload.warning } : current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profile could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (!data || !preferences) return (
    <main className="min-h-screen bg-slate-950 p-6 text-white">
      <div className="mx-auto max-w-xl rounded-xl border border-slate-700 bg-slate-900 p-5" role={message ? "alert" : undefined}>
        {embedded && <ModalDashboardLink href={profileDashboardHref} className="mb-4 inline-block rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink>}
        {!embedded && <h1 className="text-xl font-bold">{message ? "Manage Profile" : "Loading profile…"}</h1>}
        {message && <p className="mt-2 text-sm text-slate-300">{message}</p>}
        {message && <button type="button" onClick={() => void load().catch((error) => setMessage(error instanceof Error ? error.message : "Profile could not be loaded.")).finally(() => setLoading(false))} disabled={loading} className="mt-4 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{loading ? "Retrying…" : "Retry"}</button>}
      </div>
    </main>
  );

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        {!embedded && <div className="flex items-center justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">{tx("CMPRI Account", "Cuenta CMPRI")}</p>
            <h1 className="mt-1 text-3xl font-bold">{tx("Manage Profile", "Administrar perfil")}</h1>
          </div>
          <ModalDashboardLink href={profileDashboardHref} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">{tx("Dashboard", "Panel")}</ModalDashboardLink>
        </div>}
        {embedded && <div className="mb-5"><ModalDashboardLink href={profileDashboardHref} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">← Dashboard</ModalDashboardLink></div>}

        {message && <div role="status" className="mt-5 rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm">{message}</div>}

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold">{tx("ChatGPT Connection", "Conexión de ChatGPT")}</h2>
              <p className="mt-1 text-sm text-slate-300">Status: <span className={data.chatgpt_connection?.connected ? "text-emerald-300" : "text-slate-300"}>{data.chatgpt_connection?.connected ? data.chatgpt_connection.access === "read_write" ? "Connected · Read and write" : "Connected · Read only" : "Not connected"}</span></p>
              <p className="mt-1 text-sm text-slate-400">{tx("When connecting from ChatGPT, sign in to CMPRI with the pre-approved Google account for your CMPRI profile. CMPRI checks your role and permissions on every tool call.", "Al conectarte desde ChatGPT, inicia sesión en CMPRI con la cuenta de Google aprobada previamente para tu perfil de CMPRI. CMPRI verifica tu rol y permisos en cada solicitud.")}</p>
            </div>
            <ModalNavigationButton href="/profile/ai-connection" className="rounded-lg border border-sky-500/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">{tx("Connect ChatGPT", "Conectar ChatGPT")}</ModalNavigationButton>
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
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
            <label className="grid gap-1 text-sm text-slate-300">{tx("Display name", "Nombre para mostrar")}<input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white" /></label>
            {!isSubmitOnlyProfile && <label className="grid gap-1 text-sm text-slate-300">{tx("Sign-in email", "Correo de inicio de sesión")}<input value={data.profile.email || ""} readOnly className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-slate-400" /></label>}
            <label className="grid gap-1 text-sm text-slate-300 sm:col-span-2">{tx("Job Title / Role", "Puesto / Rol")}<input value={isHousekeeping ? "Housekeeping" : roleDisplayName(data.profile.role || "Unknown")} readOnly className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-slate-400" /></label>
          </div>
        </section>

        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <ModalNavigationButton href="/feedback?route=%2Fprofile" className="rounded-lg border border-amber-500/50 bg-amber-950/20 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-900/30">Report a Problem / Suggestion</ModalNavigationButton>
          {data.can_manage_users && <ModalNavigationButton href="/management/users" className="rounded-lg border border-sky-500/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">{tx("User Management", "Administración de usuarios")}</ModalNavigationButton>}
          {isSubmitOnlyProfile && <button type="button" onClick={() => void signOut()} aria-label={tx("Sign Out", "Cerrar sesión")} title={tx("Sign Out", "Cerrar sesión")} className="grid size-8 place-items-center rounded-lg border border-red-400/50 bg-red-950/30 text-red-100 hover:bg-red-900/40">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 17l5-5-5-5M15 12H3m9-7h5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
            </svg>
          </button>}
          <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-blue-700 px-5 py-2 font-bold text-white hover:bg-blue-600 disabled:opacity-50">{busy ? tx("Saving…", "Guardando…") : tx("Save Profile", "Guardar perfil")}</button>
        </div>
      </div>
    </main>
  );
}
