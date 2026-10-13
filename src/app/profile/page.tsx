"use client";

import { useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { accountRoleDisplayName, roleDisplayName } from "@/lib/account-display";
import { signOutDevice } from "@/lib/supabase/client";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import ModalNavigationButton from "@/components/ModalNavigationButton";
import useEmbeddedModal from "@/components/use-embedded-modal";
import { isSubmitOnlyRole } from "@/lib/server/roles";
import { isNotificationScheduleEligibleProfile, isWebPushEligibleProfile } from "@/lib/notifications/schedule";
import PhoneNotificationRow from "@/components/PhoneNotificationRow";

type Profile = { id: string; email: string | null; full_name: string | null; role: string | null; secondary_roles?: string[] };
type Preferences = {
  language: "en" | "es";
  appearance: "light" | "dark";
  notification_mode: "in_app" | "email" | "both";
  notifications: { new_work_orders: boolean; status_changes: boolean; mentions: boolean };
};
type ScheduleDay = { enabled: boolean; start: string; end: string };
type PhoneNotificationSettings = {
  timezone: string;
  schedule: Record<"monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday", ScheduleDay>;
};
type PhoneNotificationPayload = {
  public_key: string;
  subscribed_on_this_device: boolean;
  configured: boolean;
  settings: PhoneNotificationSettings;
};
type ChatGptConnection = { connected: boolean; status: "active" | "disconnected"; access: "read_write" | "read_only" | "disconnected"; oauth_connected?: boolean; oauth_access?: "read_write" | "read_only" | "disconnected"; provider: string; endpoint: string; message: string; personal_link_active?: boolean } | null;
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

const NOTIFICATION_DAYS = [
  ["monday", "Monday"],
  ["tuesday", "Tuesday"],
  ["wednesday", "Wednesday"],
  ["thursday", "Thursday"],
  ["friday", "Friday"],
  ["saturday", "Saturday"],
  ["sunday", "Sunday"],
] as const;

const NOTIFICATION_TIMES = Array.from({ length: 96 }, (_, index) => {
  const minutes = index * 15;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { value, label: `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}` };
});

function notificationTimeLabel(value: string) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function base64KeyToBytes(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(window.atob(base64), (character) => character.charCodeAt(0));
}

export default function ProfilePage() {
  const embedded = useEmbeddedModal();
  const [data, setData] = useState<Payload | null>(null);
  const [name, setName] = useState("");
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phoneSettings, setPhoneSettings] = useState<PhoneNotificationSettings | null>(null);
  const [phoneSubscribed, setPhoneSubscribed] = useState(false);
  const [phonePublicKey, setPhonePublicKey] = useState("");
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneMessage, setPhoneMessage] = useState("");
  const [phoneSupported, setPhoneSupported] = useState(false);
  const isSpanish = preferences?.language === "es";
  const displayedRole = accountRoleDisplayName(data?.profile || {});
  const isHousekeeping = roleDisplayName(data?.profile.role || "") === "Lead Housekeeper";
  const isSubmitOnlyProfile = ["Front Desk", "Front Desk Manager", "Lead Housekeeper"].includes(roleDisplayName(data?.profile.role || ""));
  const canManageChatgptConnection = !isSubmitOnlyRole(data?.profile.role);
  const profileDashboardHref = isSubmitOnlyProfile
    ? "/work-orders"
    : "/engineering";
  const tx = (english: string, spanish: string) => isSpanish ? spanish : english;

  function closeProfileModal() {
    if (embedded && window.parent !== window) {
      const modalToken = new URLSearchParams(window.location.search).get("modalToken") || "";
      window.parent.postMessage({ type: "cmpri-modal-close", modalToken }, window.location.origin);
    }
  }

  const profileHeader = (
    <header className="mb-5 flex items-center justify-between gap-4 border-b border-slate-800 pb-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">{tx("CMPRI Account", "Cuenta CMPRI")}</p>
        <h1 className="mt-1 text-2xl font-bold">{tx("Manage Profile", "Administrar perfil")}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!embedded && <ModalDashboardLink href={profileDashboardHref} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">{tx("Dashboard", "Panel")}</ModalDashboardLink>}
        {embedded && <button type="button" onClick={closeProfileModal} aria-label={tx("Close Manage Profile", "Cerrar Administrar perfil")} title={tx("Close", "Cerrar")} className="grid size-10 place-items-center rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white">
          <svg aria-hidden="true" viewBox="0 0 10 10" className="size-3"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>}
      </div>
    </header>
  );

  async function signOut() {
    try {
      await signOutDevice();
      if (embedded && window.parent !== window) {
        const modalToken = new URLSearchParams(window.location.search).get("modalToken") || "";
        window.parent.postMessage({ type: "cmpri-modal-sign-out", modalToken }, window.location.origin);
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
    if (isNotificationScheduleEligibleProfile(result.profile)) {
      const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration("/") : undefined;
      const currentSubscription = await registration?.pushManager.getSubscription();
      const endpoint = currentSubscription?.endpoint;
      const phoneUrl = endpoint
        ? `/api/profile/phone-notifications?endpoint=${encodeURIComponent(endpoint)}`
        : "/api/profile/phone-notifications";
      const phoneResponse = await fetch(phoneUrl, { headers: await headers(), cache: "no-store" });
      const phonePayload = await phoneResponse.json().catch(() => ({})) as Partial<PhoneNotificationPayload> & { error?: string };
      if (!phoneResponse.ok) {
        setPhoneMessage(phonePayload.error || "Phone notification settings could not be loaded.");
      } else if (phonePayload.settings && typeof phonePayload.public_key === "string") {
        const settings = phonePayload.settings;
        setPhoneSettings(phonePayload.configured ? settings : { ...settings, timezone: localTimezone() });
        setPhoneSubscribed(phonePayload.subscribed_on_this_device === true);
        setPhonePublicKey(phonePayload.public_key);
        setPhoneSupported("serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
        setPhoneMessage("");
      } else {
        setPhoneMessage("Phone notification settings returned an invalid response.");
      }
    } else {
      setPhoneSettings(null);
      setPhoneSubscribed(false);
      setPhonePublicKey("");
    }
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
    if (!preferences) return;
    if (!name.trim()) {
      setMessage(tx("Enter a display name before saving.", "Ingrese un nombre para mostrar antes de guardar."));
      return;
    }
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

  async function savePhoneSchedule() {
    if (!phoneSettings) return;
    setPhoneBusy(true);
    setPhoneMessage("");
    try {
      const response = await fetch("/api/profile/phone-notifications", {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ action: "schedule", ...phoneSettings }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Phone notification schedule could not be saved.");
      setPhoneSettings(payload.settings as PhoneNotificationSettings);
      setPhoneMessage("Notification schedule saved.");
    } catch (error) {
      setPhoneMessage(error instanceof Error ? error.message : "Phone notification schedule could not be saved.");
    } finally {
      setPhoneBusy(false);
    }
  }

  async function enablePhoneNotifications() {
    if (!phoneSettings) return;
    setPhoneBusy(true);
    setPhoneMessage("");
    try {
      if (!phoneSupported || !phonePublicKey || !window.isSecureContext) {
        throw new Error("Web Push is unavailable in this browser or server configuration.");
      }
      const permission = Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Browser notification permission was not granted.");
      const scheduleResponse = await fetch("/api/profile/phone-notifications", {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ action: "schedule", ...phoneSettings }),
      });
      const schedulePayload = await scheduleResponse.json().catch(() => ({}));
      if (!scheduleResponse.ok) throw new Error(schedulePayload.error || "Notification schedule could not be saved.");
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const ready = await navigator.serviceWorker.ready;
      const subscription = await ready.pushManager.getSubscription() || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64KeyToBytes(phonePublicKey),
      });
      const response = await fetch("/api/profile/phone-notifications", {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ action: "subscribe", subscription: subscription.toJSON() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "This device could not be registered for phone notifications.");
      setPhoneSubscribed(true);
      setPhoneMessage("Phone notifications are enabled on this device.");
    } catch (error) {
      setPhoneMessage(error instanceof Error ? error.message : "Phone notifications could not be enabled.");
    } finally {
      setPhoneBusy(false);
    }
  }

  async function disablePhoneNotifications() {
    setPhoneBusy(true);
    setPhoneMessage("");
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch("/api/profile/phone-notifications", {
          method: "POST",
          headers: await headers(),
          body: JSON.stringify({ action: "unsubscribe", endpoint: subscription.endpoint }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "This device could not be removed from phone notifications.");
        await subscription.unsubscribe();
      }
      setPhoneSubscribed(false);
      setPhoneMessage("Phone notifications are disabled on this device.");
    } catch (error) {
      setPhoneMessage(error instanceof Error ? error.message : "Phone notifications could not be disabled.");
    } finally {
      setPhoneBusy(false);
    }
  }

  if (!data || !preferences) return (
    <main className="min-h-screen bg-slate-950 p-6 text-white">
      <div className="mx-auto max-w-xl">
        {profileHeader}
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-5" role={message ? "alert" : undefined}>
          {!message && <h2 className="text-xl font-bold">Loading profile…</h2>}
          {message && <p className="text-sm text-slate-300">{message}</p>}
          {message && <button type="button" onClick={() => void load().catch((error) => setMessage(error instanceof Error ? error.message : "Profile could not be loaded.")).finally(() => setLoading(false))} disabled={loading} className="mt-4 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{loading ? "Retrying…" : "Retry"}</button>}
        </div>
      </div>
    </main>
  );

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        {profileHeader}

        {message && <div role="status" className="mt-5 rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm">{message}</div>}

        {canManageChatgptConnection && <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold">{tx("ChatGPT Connection", "Conexión de ChatGPT")}</h2>
              <p className="mt-1 text-sm text-slate-300">Status: <span className={data.chatgpt_connection?.connected ? "text-emerald-300" : "text-slate-300"}>{data.chatgpt_connection?.oauth_connected ? data.chatgpt_connection.oauth_access === "read_write" ? "OAuth connected · Read and write" : "OAuth connected · Read only" : data.chatgpt_connection?.personal_link_active ? "Legacy private link active" : "Not connected"}</span></p>
              <p className="mt-1 text-sm text-slate-400">{tx("Connect ChatGPT with secure per-user OAuth. CMPRI checks your current role and permissions on every tool call.", "Conecta ChatGPT con OAuth seguro por usuario. CMPRI verifica tu rol y permisos actuales en cada solicitud.")}</p>
            </div>
            <ModalNavigationButton href="/profile/ai-connection" className="rounded-lg border border-sky-500/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">{tx("Connect ChatGPT", "Conectar ChatGPT")}</ModalNavigationButton>
          </div>
        </section>}

        {phoneSettings && <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-xl font-bold">{tx("Notifications", "Notificaciones")}</h2>
          {!phoneSupported && <p role="status" className="mt-3 text-sm text-amber-200">{tx("This browser does not support Web Push notifications.", "Este navegador no admite notificaciones Web Push.")}</p>}
          {phoneSupported && !phonePublicKey && <p role="status" className="mt-3 text-sm text-amber-200">{tx("Phone notifications are not configured on this server.", "Las notificaciones del teléfono no están configuradas en este servidor.")}</p>}
          <PhoneNotificationRow subscribed={phoneSubscribed} busy={phoneBusy} supported={phoneSupported}
            configured={!!phonePublicKey} eligible={isWebPushEligibleProfile(data.profile)} userId={data.profile.id}
            spanish={!!isSpanish} onToggle={() => void (phoneSubscribed ? disablePhoneNotifications() : enablePhoneNotifications())} />
          <div className="mt-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="font-semibold">{tx("Notification Schedule", "Horario de notificaciones")}</h3>
                <label className="mt-2 grid gap-1 text-sm text-slate-300">
                  {tx("Time zone", "Zona horaria")}
                  <input value={phoneSettings.timezone} onChange={(event) => setPhoneSettings({ ...phoneSettings, timezone: event.target.value })} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white" />
                </label>
              </div>
              <button type="button" disabled={phoneBusy} onClick={() => void savePhoneSchedule()} className="min-h-10 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-100 disabled:opacity-50">{tx("Save Schedule", "Guardar horario")}</button>
            </div>
            <div className="mt-3 grid gap-2">
              {NOTIFICATION_DAYS.map(([day, label]) => (
                <div key={day} className="grid gap-2 rounded-lg border border-slate-800 p-2 sm:grid-cols-[minmax(7rem,1fr)_auto_minmax(7rem,1fr)_minmax(7rem,1fr)] sm:items-center">
                  <span className="text-sm">{tx(label, label)}</span>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={phoneSettings.schedule[day].enabled} onChange={(event) => setPhoneSettings({
                      ...phoneSettings,
                      schedule: { ...phoneSettings.schedule, [day]: { ...phoneSettings.schedule[day], enabled: event.currentTarget.checked } },
                    })} className="size-4 accent-sky-500" />
                    {phoneSettings.schedule[day].enabled ? tx("On", "Activado") : tx("Off", "Desactivado")}
                  </label>
                  {(["start", "end"] as const).map((field) => {
                    const value = phoneSettings.schedule[day][field];
                    const customTime = value && !NOTIFICATION_TIMES.some((option) => option.value === value);
                    return <label key={field} className="grid min-w-0 gap-1 text-xs text-slate-400">
                      {tx(field === "start" ? "Start" : "End", field === "start" ? "Inicio" : "Fin")}
                      <select value={value} onChange={(event) => setPhoneSettings({
                        ...phoneSettings,
                        schedule: { ...phoneSettings.schedule, [day]: { ...phoneSettings.schedule[day], [field]: event.target.value } },
                      })} className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white shadow-sm transition-colors focus-visible:border-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30">
                        {customTime && <option value={value}>{notificationTimeLabel(value)} (current)</option>}
                        {NOTIFICATION_TIMES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>;
                  })}
                </div>
              ))}
            </div>
          </div>
          {phoneMessage && <p role="status" className="mt-4 rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-200">{phoneMessage}</p>}
        </section>}
        {!phoneSettings && phoneMessage && data && isNotificationScheduleEligibleProfile(data.profile) && <section className="mt-4 rounded-2xl border border-amber-500/40 bg-amber-950/20 p-5">
          <h2 className="text-xl font-bold">{tx("Notifications", "Notificaciones")}</h2>
          <p role="alert" className="mt-3 text-sm text-amber-100">{phoneMessage}</p>
          <button type="button" onClick={() => void load().catch((error) => setPhoneMessage(error instanceof Error ? error.message : "Phone notification settings could not be loaded."))} className="mt-3 rounded-lg border border-amber-400/50 px-3 py-2 text-sm font-semibold text-amber-100">{tx("Retry", "Reintentar")}</button>
        </section>}

        <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-xl font-bold">{tx("Personal Preferences", "Preferencias personales")}</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm text-slate-300">{tx("Language", "Idioma")}<select value={preferences.language} disabled={data.profile_settings_available === false} onChange={(event) => setPreferences({ ...preferences, language: event.target.value as Preferences["language"] })} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white disabled:opacity-50"><option value="en">English</option><option value="es">Español</option></select></label>
            <label className="grid gap-1 text-sm text-slate-300">{tx("Appearance", "Apariencia")}<select value={preferences.appearance} disabled={data.profile_settings_available === false} onChange={(event) => setPreferences({ ...preferences, appearance: event.target.value as Preferences["appearance"] })} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white disabled:opacity-50"><option value="dark">{tx("Dark", "Oscuro")}</option><option value="light">{tx("Light", "Claro")}</option></select></label>
          </div>
          {!isSubmitOnlyProfile && <div className="mt-4 grid gap-1 text-sm text-slate-300">
            <label>{tx("Notification delivery", "Entrega de notificaciones")}<select value={preferences.notification_mode} disabled={data.profile_settings_available === false} onChange={(event) => setPreferences({ ...preferences, notification_mode: event.target.value as Preferences["notification_mode"] })} className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-white disabled:opacity-50"><option value="in_app">{tx("In-app notifications", "Notificaciones en la aplicación")}</option><option value="email">{tx("Email notifications", "Notificaciones por correo")}</option><option value="both">{tx("Both", "Ambas")}</option></select></label>
          </div>}
          {!isSubmitOnlyProfile && <fieldset disabled={data.profile_settings_available === false} className="mt-4 grid gap-2 text-sm text-slate-300 disabled:opacity-50">
            <legend className="mb-2 font-semibold">{tx("Notify me about", "Notificarme sobre")}</legend>
            {([["new_work_orders", "New work orders", "Nuevas órdenes de trabajo"], ["status_changes", "Status changes", "Cambios de estado"], ["mentions", "Ticket mentions", "Menciones en tickets"]] as const).map(([key, english, spanish]) => (
              <label key={key} className="flex min-h-10 items-center gap-3">
                <input
                  type="checkbox"
                  checked={preferences.notifications[key]}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setPreferences((current) => current
                      ? { ...current, notifications: { ...current.notifications, [key]: checked } }
                      : current);
                  }}
                  className="size-4 accent-sky-500"
                />
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
            <label className="grid gap-1 text-sm text-slate-300 sm:col-span-2">{tx("Job Title / Role", "Puesto / Rol")}<input value={isHousekeeping ? "Housekeeping" : displayedRole || "Unknown"} readOnly className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-slate-400" /></label>
          </div>
        </section>

        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <ModalNavigationButton href="/feedback?route=%2Fprofile" className="rounded-lg border border-amber-500/50 bg-amber-950/20 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-900/30">Report a Problem / Suggestion</ModalNavigationButton>
          {data.can_manage_users && <ModalNavigationButton href="/management/users" className="rounded-lg border border-sky-500/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">{tx("User Management", "Administración de usuarios")}</ModalNavigationButton>}
          {isSubmitOnlyProfile && <button type="button" onClick={() => void signOut()} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-red-400/50 bg-red-950/30 px-4 py-2 text-sm font-semibold text-red-100 hover:bg-red-900/40">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-4 shrink-0">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 17l5-5-5-5M15 12H3m9-7h5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
            </svg>
            {tx("Sign Out", "Cerrar sesión")}
          </button>}
          <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-blue-700 px-5 py-2 font-bold text-white hover:bg-blue-600 disabled:opacity-50">{busy ? tx("Saving…", "Guardando…") : tx("Save Profile", "Guardar perfil")}</button>
        </div>
      </div>
    </main>
  );
}
