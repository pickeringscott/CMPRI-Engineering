"use client";
import { sharedFetch as fetch } from "@/lib/events/shared-fetch";

import { FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  createClient,
  remembersDevice,
  setRememberOnDevice,
  signOutDevice,
  getValidSession,
  OAUTH_PENDING_KEY,
} from "@/lib/supabase/client";
import { APP_TITLE } from "@/lib/constants";

async function authorizedLanding(token: string, signal?: AbortSignal): Promise<"/work-orders" | "/technician" | "/engineering" | "/front-desk"> {
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
  if (result.landing !== "/work-orders" && result.landing !== "/technician" && result.landing !== "/engineering" && result.landing !== "/front-desk") {
    throw new Error("CMPRI returned an invalid account destination.");
  }
  return result.landing;
}

function oauthCallbackParams() {
  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  return new URLSearchParams([...query, ...fragment]);
}

function hasOAuthCallback() {
  return window.sessionStorage.getItem(OAUTH_PENDING_KEY) === "true";
}

function subscribeToLocation(callback: () => void) {
  window.addEventListener("popstate", callback);
  window.addEventListener("hashchange", callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener("hashchange", callback);
  };
}

export default function SignInPage() {
  const router = useRouter();
  const processingOAuthCallback = useSyncExternalStore(subscribeToLocation, hasOAuthCallback, () => false);
  const [message, setMessage] = useState("");
  const [initializing, setInitializing] = useState(true);
  const [redirecting, setRedirecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);
  const [rememberMe, setRememberMe] = useState(false);
  const [showPasswordAccess, setShowPasswordAccess] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const callbackParams = oauthCallbackParams();
    const isOAuthCallback = hasOAuthCallback();
    void (async () => {
      try {
        setRememberMe(remembersDevice());
        const session = await getValidSession();
        if (session) {
          const landing = await authorizedLanding(session.access_token, controller.signal);
          if (!controller.signal.aborted) {
            window.sessionStorage.removeItem(OAUTH_PENDING_KEY);
            setRedirecting(true);
            router.replace(landing);
          }
        } else if (isOAuthCallback) {
          window.sessionStorage.removeItem(OAUTH_PENDING_KEY);
          setMessage(
            callbackParams.get("error_description")
              || callbackParams.get("error")
              || "Google sign-in did not complete. Please try again.",
          );
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (isOAuthCallback) window.sessionStorage.removeItem(OAUTH_PENDING_KEY);
          setRedirecting(false);
          setMessage(error instanceof Error ? error.message : "Unable to restore this device session.");
        }
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
      window.sessionStorage.setItem(OAUTH_PENDING_KEY, "true");
      const redirectTo = `${window.location.origin}/`;
      const { data, error } = await createClient().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo },
      });
      if (error) throw error;
      if (data?.url) {
        window.location.assign(data.url);
        return;
      }
      throw new Error("Google sign-in did not return a redirect URL.");
    } catch (error) {
      window.sessionStorage.removeItem(OAUTH_PENDING_KEY);
      setRedirecting(false);
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
        password: passwordRef.current?.value || "",
      });
      if (error) throw error;
      const session = await getValidSession();
      if (!session) throw new Error("The password sign-in did not create a session.");
      const landing = await authorizedLanding(session.access_token);
      setRedirecting(true);
      router.replace(landing);
    } catch (error) {
      setRedirecting(false);
      setMessage(error instanceof Error ? error.message : "Password sign-in could not be completed.");
      setBusy(false);
    }
  }

  const disabled = initializing || busy || redirecting;
  if (redirecting || (initializing && processingOAuthCallback)) {
    return (
      <main className="flex min-h-[100dvh] w-full items-start justify-center bg-slate-950 px-4 pt-4 text-center text-amber-400">
        <p role="status" aria-live="polite" className="text-[16pt] font-semibold">
          Loading Dashboard...<br />
          Have a wonderful day!
        </p>
      </main>
    );
  }
  return (
    <main className="grid min-h-[100svh] w-full items-start justify-items-center overflow-y-auto overscroll-contain bg-slate-950 px-4 pt-4 text-white sm:pt-6">
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
          <div className="flex items-center justify-between gap-3 px-1.5">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" disabled={disabled} checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} className="h-4 w-4" />
              Remember me
            </label>
            <button
              type="button"
              disabled={disabled}
              aria-expanded={showPasswordAccess}
              aria-controls="password-access"
              onClick={() => setShowPasswordAccess((open) => !open)}
              className="min-h-9 px-2 text-sm font-semibold text-sky-300 underline decoration-sky-500/50 underline-offset-2 hover:text-sky-200 disabled:opacity-50"
            >
              More…
            </button>
          </div>
          {showPasswordAccess && (
            <div id="password-access" className="border-t border-slate-800 pt-3">
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
                ref={passwordRef}
                placeholder="Password"
                className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-white"
              />
              <button type="submit" disabled={disabled} className="min-h-11 w-full rounded-lg border border-amber-400 px-4 font-bold text-amber-300 transition hover:bg-amber-400/10 disabled:opacity-60">
                {busy ? "Signing in…" : "Sign in with Password"}
              </button>
              </form>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
