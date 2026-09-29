"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import useEmbeddedModal from "@/components/use-embedded-modal";

type Connection = {
  connected: boolean;
  status: "active" | "disconnected";
  access: "read_write" | "read_only" | "disconnected";
  endpoint: string;
  message: string;
  oauth_connected: boolean;
  oauth_access: "read_write" | "read_only" | "disconnected";
  personal_link_active: boolean;
};

const EMPTY_CONNECTION: Connection = {
  connected: false,
  status: "disconnected",
  access: "disconnected",
  endpoint: "https://www.cmpri-engineering.com/api/mcp",
  message: "Connect ChatGPT using OAuth. CMPRI checks your current account permissions for every tool call.",
  oauth_connected: false,
  oauth_access: "disconnected",
  personal_link_active: false,
};

export default function AiConnectionPage() {
  const router = useRouter();
  const embedded = useEmbeddedModal();
  const [connection, setConnection] = useState(EMPTY_CONNECTION);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function headers() {
    const session = await getValidSession();
    if (!session?.access_token) throw new Error("Sign in again to manage your CMPRI connection.");
    return { Authorization: `Bearer ${session.access_token}` };
  }

  async function load() {
    const response = await fetch("/api/profile/ai-connection", { headers: await headers(), cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "ChatGPT connection status could not be loaded.");
    setConnection(payload.connection as Connection);
  }

  useEffect(() => {
    let current = true;
    void Promise.resolve().then(load)
      .catch((loadError) => { if (current) setError(loadError instanceof Error ? loadError.message : "Connection status could not be loaded."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/profile/ai-connection", {
        method: "DELETE",
        headers: await headers(),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "ChatGPT could not be disconnected.");
      setConnection(payload.connection as Connection);
      setMessage("ChatGPT access to CMPRI has been revoked for this account.");
      window.parent.postMessage({
        type: "cmpri-profile-ai-updated",
        modalToken: new URLSearchParams(window.location.search).get("modalToken") || "",
      }, window.location.origin);
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : "ChatGPT could not be disconnected.");
    } finally {
      setBusy(false);
    }
  }

  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(connection.endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Could not copy the CMPRI MCP endpoint. Select and copy it manually.");
    }
  }

  function close() {
    if (embedded && window.parent !== window) {
      window.parent.postMessage({
        type: "cmpri-modal-close",
        modalToken: new URLSearchParams(window.location.search).get("modalToken") || "",
      }, window.location.origin);
    } else {
      router.push("/profile");
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 p-4 text-white sm:p-6">
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-300">CMPRI · ChatGPT connector</p>
            <h1 className="mt-1 text-2xl font-bold">Connect ChatGPT</h1>
            <p className="mt-2 text-sm text-slate-300">Connect your ChatGPT account to CMPRI using OAuth. Each user authorizes their own CMPRI account; no shared CMPRI credential or OpenAI API key is used.</p>
          </div>
          <button type="button" onClick={close} className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">{embedded ? "Done" : "Back to profile"}</button>
        </div>

        {loading ? <p role="status" className="mt-6 text-sm text-slate-300">Checking connection…</p> : <>
          <section className="mt-5 rounded-xl border border-slate-700 bg-slate-950/60 p-4">
            <p className="text-sm">Status: <span className={connection.oauth_connected ? "font-semibold text-emerald-300" : "font-semibold text-slate-300"}>{connection.oauth_connected ? connection.oauth_access === "read_write" ? "OAuth connected · Read and write" : "OAuth connected · Read only" : connection.personal_link_active ? "Legacy private link active" : "Not connected"}</span></p>
          <p className="mt-2 text-sm text-slate-300">{connection.message}</p>
          </section>

          <section className="mt-5 space-y-3 rounded-xl border border-slate-700 p-4">
          <h2 className="font-semibold">Connect with secure OAuth</h2>
          <p className="text-sm text-slate-300">In ChatGPT, add a custom MCP app using the CMPRI endpoint below and select <strong>OAuth</strong>. ChatGPT will open CMPRI sign-in; sign in with the Google account linked to your CMPRI profile and approve the requested access. CMPRI checks your current role and permissions on every call.</p>
          <p className="text-sm text-slate-300">There is no payment UI. OpenAI API credits are separate from OAuth and do not pay for ChatGPT model usage; this connection only grants ChatGPT access to your CMPRI account.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-slate-950 px-3 py-2 text-xs text-sky-200">{connection.endpoint}</code>
            <button type="button" onClick={() => void copyEndpoint()} className="rounded-lg border border-slate-600 px-3 py-2 text-sm font-semibold hover:bg-slate-800">{copied ? "Copied" : "Copy MCP endpoint"}</button>
          </div>
          <ol className="list-inside list-decimal space-y-1 text-sm text-slate-300">
            <li>Open ChatGPT Apps and create a custom app/connector.</li>
            <li>Use the CMPRI MCP endpoint and select OAuth authentication.</li>
            <li>Sign in to CMPRI and approve access for your account.</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <a href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-slate-600 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800">Open ChatGPT apps</a>
          </div>
          </section>

          {(connection.oauth_connected || connection.personal_link_active) && <button type="button" disabled={busy} onClick={() => void disconnect()} className="mt-5 rounded-lg border border-red-700 px-4 py-2 text-sm font-bold text-red-200 hover:bg-red-950/30 disabled:opacity-50">{busy ? "Disconnecting…" : "Revoke ChatGPT access"}</button>}
        </>}
        {message && <p role="status" className="mt-4 text-sm text-emerald-200">{message}</p>}
        {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
      </div>
    </main>
  );
}
