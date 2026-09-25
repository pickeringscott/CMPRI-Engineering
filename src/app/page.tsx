"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createClient,
  remembersDevice,
  setRememberOnDevice,
  signOutDevice,
  getValidSession,
} from "@/lib/supabase/client";
import { APP_TITLE } from "@/lib/constants";

async function authorizedLanding(token: string, signal?: AbortSignal): Promise<"/work-orders" | "/technician" | "/engineering"> {
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
  if (result.landing !== "/work-orders" && result.landing !== "/technician" && result.landing !== "/engineering") {
    throw new Error("CMPRI returned an invalid account destination.");
  }
  return result.landing;
}

export default function SignInPage() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setRememberMe(remembersDevice());
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
      setRememberOnDevice(rememberMe);
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

  async function signInWithPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      setRememberOnDevice(rememberMe);
      const { error } = await createClient().auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;
      const session = await getValidSession();
      if (!session) throw new Error("The password sign-in did not create a session.");
      const landing = await authorizedLanding(session.access_token);
      router.replace(landing);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Password sign-in could not be completed.");
      setBusy(false);
    }
  }

  const disabled = initializing || busy;
  return (
    <main className="grid min-h-[100dvh] w-full place-items-center bg-slate-950 px-4 text-white">
      <section aria-busy={disabled} className="w-full max-w-[22rem] rounded-[22px] border border-slate-800/80 bg-slate-900 p-4 shadow-lg shadow-slate-950/25">
        <div className="text-center">
          <p className="text-[0.79rem] font-semibold uppercase tracking-[0.2em] text-amber-400">Hawkeye Hotels</p>
          <h1 className="mt-1 text-[1.7rem] font-bold leading-tight">{APP_TITLE}</h1>
        </div>
        {message ? <p role="status" aria-live="polite" className="mt-3 rounded-lg border border-slate-700 bg-slate-950 p-2.5 text-sm text-slate-200">{message}</p> : null}
        <div className="mt-3 space-y-3">
          <button type="button" disabled={disabled} onClick={() => void signInWithGoogle()} className="flex min-h-11 w-full items-center justify-center gap-3 rounded-lg border border-[#747775] bg-white px-4 font-medium text-[#1f1f1f] transition hover:bg-[#f7f8f8] disabled:opacity-60">
            <svg aria-hidden="true" className="h-5 w-5 shrink-0" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.39 30.47 0 24 0 14.61 0 6.51 5.38 2.54 13.22l7.98 6.2C12.43 13.13 17.74 9.5 24 9.5Z" />
              <path fill="#4285F4" d="M46.98 24.55c0-1.64-.15-3.22-.42-4.75H24v9.02h12.86c-.55 2.9-2.2 5.36-4.68 7.01l7.56 5.87c4.41-4.07 7.24-10.07 7.24-17.15Z" />
              <path fill="#FBBC05" d="M10.52 28.58A14.5 14.5 0 0 1 9.75 24c0-1.59.27-3.14.77-4.58l-7.98-6.2A24 24 0 0 0 0 24c0 3.87.93 7.53 2.54 10.78l7.98-6.2Z" />
              <path fill="#34A853" d="M24 48c6.48 0 11.92-2.14 15.88-5.83l-7.56-5.87c-2.1 1.4-4.79 2.23-8.32 2.23-6.26 0-11.57-3.63-13.48-8.72l-7.98 6.2C6.51 42.62 14.61 48 24 48Z" />
            </svg>
            <span>{busy ? "Opening Google…" : "Continue with Google"}</span>
          </button>
          <label className="ml-1.5 flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" disabled={disabled} checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} className="h-4 w-4" />
            Remember me
          </label>
          <div className="border-t border-slate-800 pt-3">
            <p className="text-[0.66rem] uppercase tracking-[0.22em] text-slate-400">Password access</p>
            <form onSubmit={signInWithPassword} className="mt-2 space-y-2.5">
              <input
                required
                disabled={disabled}
                type="email"
                autoComplete="username"
                aria-label="Email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Email"
                className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-white"
              />
              <input
                required
                disabled={disabled}
                type="password"
                autoComplete="current-password"
                aria-label="Password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
                className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-white"
              />
              <button type="submit" disabled={disabled} className="min-h-11 w-full rounded-lg border border-amber-400 px-4 font-bold text-amber-300 transition hover:bg-amber-400/10 disabled:opacity-60">
                {busy ? "Signing in…" : "Sign in with Password"}
              </button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
