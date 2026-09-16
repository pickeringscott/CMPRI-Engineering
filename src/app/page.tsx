"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  createClient,
  remembersDevice,
  setRememberOnDevice,
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [message, setMessage] = useState("");
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setRemember(remembersDevice());
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

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (initializing || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      setRememberOnDevice(remember);
      const supabase = createClient();
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error || !data.session) throw new Error(error?.message || "Sign-in failed.");
      const landing = await authorizedLanding(data.session.access_token);
      setPassword("");
      router.replace(landing);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to sign in.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function sendPasswordReset() {
    const address = email.trim();
    if (!address) {
      setMessage("Enter your email address first.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const { error } = await createClient().auth.resetPasswordForEmail(address, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setMessage("Password reset email sent. Check your inbox.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to send the reset email.");
    } finally {
      setBusy(false);
    }
  }

  const disabled = initializing || busy;
  return (
    <main className="grid min-h-[100dvh] w-full place-items-center bg-slate-950 px-5 text-white">
      <form onSubmit={signIn} aria-busy={disabled} className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-400">Hawkeye Hotels</p>
          <h1 className="mt-2 text-2xl font-bold">{APP_TITLE}</h1>
          <p className="mt-1 text-sm text-slate-400">{HOTEL_NAME}</p>
        </div>
        {message ? <p role="alert" className="mt-5 rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-200">{message}</p> : null}
        <fieldset disabled={disabled} className="mt-6 space-y-4">
          <label className="block text-sm font-medium">
            Email Address
            <input required type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-4" />
          </label>
          <label className="block text-sm font-medium">
            Password
            <input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-4" />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="h-4 w-4" />
            Remember on this device
          </label>
          <button type="submit" className="min-h-12 w-full rounded-lg bg-amber-400 font-bold text-slate-950 disabled:opacity-60">
            {initializing ? "Checking session…" : busy ? "Signing in…" : "Sign In"}
          </button>
        </fieldset>
        <button type="button" disabled={disabled} onClick={() => void sendPasswordReset()} className="mt-4 w-full text-sm text-slate-400 underline decoration-slate-600 underline-offset-4 disabled:opacity-60">
          Forgot Password?
        </button>
      </form>
    </main>
  );
}
