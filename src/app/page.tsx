"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createClient,
  signOutDevice,
  getValidSession,
} from "@/lib/supabase/client";
import { APP_TITLE, HOTEL_NAME } from "@/lib/constants";

async function authorizedLanding(token: string, signal?: AbortSignal): Promise<"/work-orders" | "/engineering"> {
  const response = await fetch("/api/session", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    await signOutDevice();
    const result = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(result?.error || "This account is not authorized for CMPRI.");
  }
  if (!response.ok) throw new Error("Unable to verify CMPRI access. Please try again.");
  const result = await response.json() as { landing?: unknown };
  if (result.landing !== "/work-orders" && result.landing !== "/engineering") {
    throw new Error("CMPRI returned an invalid account destination.");
  }
  return result.landing;
}

export default function SignInPage() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const session = await getValidSession();
        if (session) {
          const landing = await authorizedLanding(session.access_token, controller.signal);
          if (!controller.signal.aborted) router.replace(landing);
        }
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Unable to restore this device session.");
      } finally {
        if (!controller.signal.aborted) setInitializing(false);
      }
    })();
    return () => controller.abort();
  }, [router]);

  async function signInWithGoogle() {
    setBusy(true);
    setMessage("");
    try {
      const redirectTo = `${window.location.origin}/`;
      const { error } = await createClient().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo },
      });
      if (error) throw error;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Google sign-in could not be started.");
      setBusy(false);
    }
  }

  const disabled = initializing || busy;
  return (
    <main className="grid min-h-[100dvh] w-full place-items-center bg-slate-950 px-5 text-white">
      <section aria-busy={disabled} className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-400">Hawkeye Hotels</p>
          <h1 className="mt-2 text-2xl font-bold">{APP_TITLE}</h1>
          <p className="mt-1 text-sm text-slate-400">{HOTEL_NAME}</p>
        </div>
        {message ? <p role="status" aria-live="polite" className="mt-5 rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-200">{message}</p> : null}
        <div className="mt-6 space-y-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Google account access</p>
          <button type="button" disabled={disabled} onClick={() => void signInWithGoogle()} className="min-h-12 w-full rounded-lg bg-white font-bold text-slate-950 transition hover:bg-slate-200 disabled:opacity-60">
            {busy ? "Opening Google…" : "Continue with Google"}
          </button>
          <p className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-300">
            Your Google email must match an active CMPRI user record.
          </p>
        </div>
      </section>
    </main>
  );
}
