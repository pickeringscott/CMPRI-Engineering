"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient, signOutDevice } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("Verifying recovery link…");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setMessage(error.message);
      else if (data.session) { setReady(true); setMessage(""); }
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY" || session) { setReady(true); setMessage(""); }
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) { setMessage("Password must contain at least 8 characters."); return; }
    if (password !== confirmation) { setMessage("Passwords do not match."); return; }
    setSaving(true);
    setMessage("");
    try {
      const { error } = await createClient().auth.updateUser({ password });
      if (error) throw error;
      setMessage("Password updated successfully. Returning to sign in…");
      await signOutDevice();
      window.setTimeout(() => router.replace("/"), 900);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update the password.");
      setSaving(false);
    }
  }

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-slate-950 px-5 text-white">
      <section className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">Hawkeye Hotels</p>
        <h1 className="mt-1.5 text-2xl font-bold">CMPRI</h1>
        <h2 className="mt-2 text-lg font-semibold">Create New Password</h2>
        {ready ? (
          <form onSubmit={updatePassword} className="mt-5 space-y-5">
            <label className="block text-sm font-medium">New Password
              <input type="password" required autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-4" />
            </label>
            <label className="block text-sm font-medium">Confirm New Password
              <input type="password" required autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-4" />
            </label>
            <button type="submit" disabled={saving} className="min-h-12 w-full rounded-lg bg-amber-400 font-bold text-slate-950 disabled:opacity-60">{saving ? "Saving…" : "Update Password"}</button>
          </form>
        ) : null}
        {message ? <p role="status" className="mt-5 rounded-lg bg-slate-950 p-4 text-sm text-slate-300">{message}</p> : null}
      </section>
    </main>
  );
}
