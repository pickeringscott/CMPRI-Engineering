"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { isInstalledMobileApp } from "@/lib/notifications/installed-mobile";
import { pushTestMessage, type PushTest } from "@/lib/notifications/push-test-status";

type Props = {
  subscribed: boolean;
  busy: boolean;
  supported: boolean;
  configured: boolean;
  eligible: boolean;
  userId: string;
  spanish: boolean;
  onToggle: () => void;
};

function readInstalledMobile() {
  const nav = navigator as Navigator & { standalone?: boolean; userAgentData?: { mobile?: boolean } };
  return isInstalledMobileApp({
    standalone: window.matchMedia("(display-mode: standalone)").matches,
    iosStandalone: nav.standalone, mobile: nav.userAgentData?.mobile,
    userAgent: nav.userAgent, platform: nav.platform, maxTouchPoints: nav.maxTouchPoints,
  });
}
function subscribeDisplayMode(callback: () => void) {
  const query = window.matchMedia("(display-mode: standalone)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}
const browserOnly = () => false;

export default function PhoneNotificationRow(props: Props) {
  const installed = useSyncExternalStore(subscribeDisplayMode, readInstalledMobile, browserOnly);
  const [test, setTest] = useState<PushTest | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const tx = (en: string, es: string) => props.spanish ? es : en;
  const pending = test?.status === "pending" || test?.status === "sending";

  const call = useCallback(async (action: "send" | "status" | "cancel", id?: string, delaySeconds?: number) => {
    const session = await getValidSession();
    if (!session?.access_token || session.user.id !== props.userId) throw new Error("Sign in again to test this device.");
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) throw new Error("Enable phone notifications on this device first.");
    const response = await fetch("/api/profile/phone-notifications/test", {
      method: "POST", cache: "no-store",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, endpoint: subscription.endpoint, id, delay_seconds: delaySeconds }),
    });
    const payload = await response.json();
    if (payload.test !== undefined) setTest(payload.test);
    if (!response.ok) throw new Error(payload.error || "The test request could not be completed.");
    return payload.test as PushTest | null;
  }, [props.userId]);

  const refresh = useCallback(async () => {
    try {
      const current = await call("status");
      if (current && (!requestId.current || current.id === requestId.current)) {
        requestId.current = null;
        setMessage("");
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Test status could not be checked."); }
  }, [call]);

  useEffect(() => {
    if (!installed || !props.eligible || !props.subscribed) return;
    void Promise.resolve().then(refresh);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [installed, props.eligible, props.subscribed, refresh]);

  useEffect(() => {
    if (!pending || !props.subscribed) return;
    // Only reads status. The server owns the delay and send, even after this page closes.
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 2500);
    return () => window.clearInterval(timer);
  }, [pending, props.subscribed, refresh]);

  async function send(delaySeconds: 0 | 10) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      // Keep the same key after a lost response; retries cannot create a second send.
      requestId.current ||= crypto.randomUUID();
      await call("send", requestId.current, delaySeconds);
      requestId.current = null;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Connection interrupted. Check test status before trying again.");
    } finally { submitting.current = false; setBusy(false); }
  }

  async function cancel() {
    if (!test || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try { await call("cancel", test.id); setMessage(""); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Test could not be cancelled."); }
    finally { submitting.current = false; setBusy(false); }
  }

  const showTests = installed && props.eligible;
  const testDisabled = props.busy || busy || pending || !props.subscribed || !props.supported || !props.configured;
  return <>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-semibold">{tx("Phone Notifications", "Notificaciones del teléfono")}</p>
        <p className="text-sm text-slate-400">{props.subscribed ? tx("Enabled on this device", "Activadas en este dispositivo") : tx("Disabled on this device", "Desactivadas en este dispositivo")}</p>
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2" aria-label="Phone notification controls">
        <button type="button" disabled={props.busy || (!props.subscribed && (!props.supported || !props.configured))} onClick={props.onToggle} className="h-10 shrink-0 rounded-lg border border-sky-400/50 bg-sky-950/30 px-4 py-2 text-sm font-semibold text-sky-100 disabled:opacity-50">
          {props.busy ? tx("Saving…", "Guardando…") : props.subscribed ? tx("Disable", "Desactivar") : tx("Enable", "Activar")}
        </button>
        {showTests && <>
          <button type="button" aria-label="Send test notification now" title="Test this device’s notifications" disabled={testDisabled} onClick={() => void send(0)} className="h-10 shrink-0 rounded-lg border border-sky-400/50 bg-sky-950/30 px-2 py-2 text-xs font-semibold text-sky-100 disabled:opacity-50">Send now</button>
          <button type="button" aria-label="Send test notification in 10 seconds" title="Test this device after locking your phone" disabled={testDisabled} onClick={() => void send(10)} className="h-10 shrink-0 rounded-lg border border-sky-400/50 bg-sky-950/30 px-2 py-2 text-xs font-semibold text-sky-100 disabled:opacity-50">Send in 10 seconds</button>
        </>}
      </div>
    </div>
    {showTests && props.subscribed && (test || message || busy) && <div role="status" className="mt-2 text-sm text-slate-300">
      <p>{message || (test ? pushTestMessage(test) : "Scheduling test…")}</p>
      {test?.status === "pending" && <button type="button" onClick={() => void cancel()} disabled={busy} className="mt-1 min-h-10 text-sky-200 underline disabled:opacity-50">Cancel test</button>}
      {message && <button type="button" onClick={() => void refresh()} disabled={busy} className="ml-3 min-h-10 text-sky-200 underline disabled:opacity-50">Check test status</button>}
    </div>}
  </>;
}
