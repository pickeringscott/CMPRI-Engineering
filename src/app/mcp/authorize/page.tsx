"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient, getValidSession } from "@/lib/supabase/client";
import { CMPRI_MCP_RESOURCE } from "@/lib/server/cmpri-mcp-oauth-scope";

type ClientDetails = { client_id: string; client_name: string };
type CmpriUser = { user: { id: string; name: string | null; email: string; role: string } };

function requestParams() {
  return new URLSearchParams(window.location.search);
}

export default function McpAuthorizePage() {
  const [client, setClient] = useState<ClientDetails | null>(null);
  const [user, setUser] = useState<CmpriUser["user"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [writeRequested, setWriteRequested] = useState(false);

  async function load() {
    const params = requestParams();
    const required = ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method"];
    if (required.some((name) => !params.get(name)) || params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256") {
      throw new Error("The ChatGPT authorization request is incomplete or unsupported.");
    }
    setWriteRequested((params.get("scope") || "").split(/\s+/).includes("cmpri:write"));
    const clientResponse = await fetch(`/oauth/authorize?client_id=${encodeURIComponent(params.get("client_id") || "")}`, { cache: "no-store" });
    const clientPayload = await clientResponse.json().catch(() => ({}));
    if (!clientResponse.ok) throw new Error(clientPayload.error_description || "This ChatGPT app is not registered with CMPRI.");
    setClient(clientPayload as ClientDetails);

    const session = await getValidSession();
    if (!session?.access_token) {
      setUser(null);
      return;
    }
    const response = await fetch("/api/session", {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "This CMPRI account cannot authorize the connection.");
    setUser((payload as CmpriUser).user);
  }

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(load)
      .catch((loadError) => { if (active) setError(loadError instanceof Error ? loadError.message : "Authorization could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const { data, error: signInError } = await createClient().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.href },
      });
      if (signInError) throw signInError;
      if (!data.url) throw new Error("CMPRI did not return a sign-in URL.");
      window.location.assign(data.url);
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : "CMPRI sign-in could not be started.");
      setBusy(false);
    }
  }

  async function approve() {
    if (busy || !user) return;
    setBusy(true);
    setError("");
    try {
      const params = requestParams();
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in to CMPRI before authorizing ChatGPT.");
      const response = await fetch("/oauth/authorize", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: params.get("client_id"),
          redirect_uri: params.get("redirect_uri"),
          code_challenge: params.get("code_challenge"),
          code_challenge_method: params.get("code_challenge_method"),
          scope: params.get("scope") || "cmpri:read",
          resource: params.get("resource") || CMPRI_MCP_RESOURCE,
          state: params.get("state"),
        }),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload.redirect_uri !== "string") throw new Error(payload.error_description || "CMPRI could not authorize this connection.");
      window.location.assign(payload.redirect_uri);
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : "CMPRI authorization failed.");
      setBusy(false);
    }
  }

  if (loading) return <main className="min-h-screen bg-slate-950 p-6 text-white"><p role="status">Loading secure CMPRI authorization…</p></main>;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-white">
      <section className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-300">CMPRI secure authorization</p>
        <h1 className="mt-2 text-2xl font-bold">Connect ChatGPT to CMPRI</h1>
        {error && <p role="alert" className="mt-4 rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-200">{error}</p>}
        {client && user ? <>
          <p className="mt-4 text-sm text-slate-200"><strong>{client.client_name}</strong> is requesting {writeRequested ? "read and write" : "read-only"} access to CMPRI as:</p>
          <p className="mt-2 rounded-lg bg-slate-950 p-3 text-sm">{user.name || user.email} · {user.role}</p>
          <p className="mt-3 text-sm text-slate-300">Tools check your active CMPRI profile, property membership, role, and permissions on every request. ChatGPT cannot use another user’s CMPRI access.</p>
          <p className="mt-3 rounded-lg border border-sky-900 bg-sky-950/40 p-3 text-sm text-sky-100">{writeRequested ? "This connection requests read and write access. CMPRI exposes only actions permitted by your current role; changes run through the same validation and checks as the CMPRI app." : "This connection requests read-only access. Reconnect later if you want to grant CMPRI write access."}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" disabled={busy} onClick={() => void approve()} className="rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-bold hover:bg-sky-600 disabled:opacity-50">{busy ? "Authorizing…" : writeRequested ? "Authorize read and write access" : "Authorize read-only access"}</button>
            <Link href="/" className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-800">Cancel</Link>
          </div>
        </> : client ? <>
          <p className="mt-4 text-sm text-slate-300">Sign in with the Google account whose email address was added to your CMPRI profile. CMPRI permissions will be checked on every tool request.</p>
          <button type="button" disabled={busy} onClick={() => void signIn()} className="mt-5 rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-bold hover:bg-sky-600 disabled:opacity-50">{busy ? "Opening Google sign-in…" : "Continue with Google"}</button>
        </> : null}
      </section>
    </main>
  );
}
