"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import SearchableSelect from "@/components/SearchableSelect";

type UserRow = { id: string; full_name: string | null; role: string | null; active: boolean | null; can_manage: boolean };

export default function UserManagementPage() {
  const router = useRouter();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [password, setPassword] = useState("");
  const [setPasswordMode, setSetPasswordMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<UserRow | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const roleOptions = roles.map((value) => ({ value, label: value }));

  const authHeaders = useCallback(async () => {
    const session = await getValidSession();
    if (!session) throw new Error("No active session.");
    return { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
  }, []);

  const loadUsers = useCallback(async () => {
    const res = await fetch("/api/users", { headers: await authHeaders(), cache: "no-store" });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Unable to load users.");
    return { users: (payload.users || []) as UserRow[], roles: (payload.assignable_roles || []) as string[] };
  }, [authHeaders]);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const session = await getValidSession();
        if (!session) {
          if (current) router.replace("/");
          return;
        }

        const result = await loadUsers();
        if (!current) return;
        setUsers(result.users);
        setRoles(result.roles);
        setRole(result.roles[0] || "");
      } catch {
        if (!current) return;
        router.replace("/");
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => { current = false; };
  }, [loadUsers, router]);

  async function addUser(event: FormEvent) {
    event.preventDefault();
    if (busy || !roles.includes(role)) return;
    if (setPasswordMode && password.trim().length < 10) {
      setMessage("A temporary password must be at least 10 characters.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const body: Record<string, unknown> = { full_name: name, email, role };
      if (setPasswordMode) body.password = password;
      const res = await fetch("/api/users", { method: "POST", headers: await authHeaders(), body: JSON.stringify(body) });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage(payload.error || "Unable to add user."); return; }
      setName("");
      setEmail("");
      setPassword("");
      setSetPasswordMode(false);
      setRole(roles[0] || "");
      setMessage(payload.user?.invited === false ? "User created with a temporary password. Share it with them privately." : "Invite email sent.");
      try { const result = await loadUsers(); setUsers(result.users); setRoles(result.roles); }
      catch { setMessage("User was added, but the list could not refresh. Please reload."); }
    } catch { setMessage("The account result could not be confirmed. Reload the list before trying again."); }
    finally { setBusy(false); }
  }

  async function updateUser(user: UserRow, patch: Partial<UserRow>) {
    if (busy || !user.can_manage) return;
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/users", { method: "PATCH", headers: await authHeaders(), body: JSON.stringify({ id: user.id, ...patch }) });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage(payload.error || "Unable to update user."); return; }
      setUsers((rows) => rows.map((row) => (row.id === user.id ? payload.user : row)));
    } catch { setMessage("The account update could not be confirmed. Reload to check its status."); }
    finally { setBusy(false); }
  }

  async function confirmDelete() {
    if (!pendingDelete || busy) return;
    const expected = (pendingDelete.full_name || "").trim();
    if (!expected || deleteConfirmName.trim() !== expected) return;
    setBusy(true);
    setMessage("");
    try {
      const headers = await authHeaders();
      const params = new URLSearchParams({ id: pendingDelete.id, confirm_name: deleteConfirmName.trim() });
      const res = await fetch(`/api/users?${params.toString()}`, { method: "DELETE", headers });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage(payload.error || "Unable to permanently delete this user."); return; }
      setUsers((rows) => rows.filter((row) => row.id !== pendingDelete.id));
      setMessage(`Permanently deleted ${expected}.`);
      setPendingDelete(null);
      setDeleteConfirmName("");
    } catch { setMessage("The deletion could not be confirmed. Reload the list to check."); }
    finally { setBusy(false); }
  }

  const deleteExpectedName = (pendingDelete?.full_name || "").trim();
  const deleteReady = !!pendingDelete && deleteExpectedName.length > 0 && deleteConfirmName.trim() === deleteExpectedName;

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Link href="/engineering" className="text-sm font-semibold text-amber-400">← Engineering Dashboard</Link>
        <div className="mt-4 flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-400">Management</p>
            <h1 className="mt-2 text-3xl font-bold">User Management</h1>
            <p className="mt-2 text-sm text-slate-400">Invite users, assign roles, deactivate access, or permanently delete test accounts.</p>
          </div>
          <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-bold">{users.filter((u) => u.active === true).length} active</span>
        </div>
        {message && <div role="status" className="mt-5 rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm">{message}</div>}
        {roles.length > 0 && (
          <form onSubmit={addUser} className="mt-6 grid gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:grid-cols-2">
            <input required disabled={busy} maxLength={200} aria-label="Full name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className="min-h-11 min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3" />
            <input required disabled={busy} maxLength={254} type="email" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="min-h-11 min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3" />
            <SearchableSelect value={role} onChange={setRole} options={roleOptions} placeholder="Role for new user" disabled={busy} required />
            <label className="flex items-center gap-2 self-center text-sm text-slate-300">
              <input type="checkbox" disabled={busy} checked={setPasswordMode} onChange={(e) => setSetPasswordMode(e.target.checked)} className="h-4 w-4" />
              Set temporary password instead of sending an invite email
            </label>
            {setPasswordMode && (
              <input required disabled={busy} minLength={10} maxLength={128} type="text" aria-label="Temporary password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Temporary password (10+ characters)" className="min-h-11 min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3 sm:col-span-2" />
            )}
            <button disabled={busy || !roles.includes(role)} className="rounded-lg bg-amber-400 px-4 py-2 font-bold text-slate-950 disabled:opacity-50 sm:col-span-2">{busy ? "Saving…" : setPasswordMode ? "Create User With Password" : "Invite User"}</button>
          </form>
        )}
        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900">
          <div className="border-b border-slate-800 px-5 py-4"><h2 className="text-xl font-bold">Users</h2></div>
          {loading ? <p className="p-5 text-slate-400">Loading…</p> : users.map((user) => (
            <div key={user.id} className="grid gap-3 border-b border-slate-800 px-5 py-4 md:grid-cols-[1fr_220px_150px_150px] md:items-center">
              <div className="min-w-0">
                <p className="break-words font-semibold">{user.full_name || "Unnamed user"}</p>
                <p className="mt-1 text-xs text-slate-500">{user.active === true ? "Active" : "Inactive"}</p>
              </div>
              {user.can_manage ? (
                <SearchableSelect value={user.role || ""} onChange={(value) => void updateUser(user, { role: value })} options={roles.includes(user.role || "") ? roleOptions : [{ value: user.role || "", label: user.role || "Unassigned" }, ...roleOptions]} placeholder={`Role for ${user.full_name || "user"}`} disabled={busy} />
              ) : (
                <p className="text-sm text-slate-400">{user.role || "Unassigned"}</p>
              )}
              {user.can_manage ? (
                <button disabled={busy} onClick={() => void updateUser(user, { active: user.active !== true })} className={`rounded-lg border px-3 py-2 text-sm font-bold disabled:opacity-50 ${user.active !== true ? "border-emerald-500/50 text-emerald-200" : "border-red-500/50 text-red-200"}`}>{user.active !== true ? "Reactivate" : "Deactivate"}</button>
              ) : (
                <span className="text-xs text-slate-500">View only</span>
              )}
              {user.can_manage ? (
                <button disabled={busy} onClick={() => { setPendingDelete(user); setDeleteConfirmName(""); }} className="rounded-lg border border-red-500 bg-red-950/40 px-3 py-2 text-sm font-bold text-red-100 disabled:opacity-50">Delete…</button>
              ) : (
                <span />
              )}
            </div>
          ))}
        </section>
      </div>

      {pendingDelete && (
        <div role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
          <div className="w-full max-w-md rounded-2xl border border-red-500/50 bg-slate-900 p-6 shadow-2xl">
            <h2 id="delete-dialog-title" className="text-lg font-bold text-red-200">Permanently Delete Account</h2>
            <p className="mt-3 text-sm text-slate-300">
              This removes <span className="font-semibold text-white">{deleteExpectedName || "this account"}</span> and every work order, draft, note, history event, and activity record they created. It cannot be undone.
            </p>
            <p className="mt-3 text-xs text-slate-400">
              For real employees who are leaving, use <span className="font-semibold text-slate-200">Deactivate</span> instead so their history is preserved. Only use <span className="font-semibold text-red-200">Delete</span> for test accounts.
            </p>
            <label className="mt-4 block text-sm font-medium text-slate-200">
              Type the full name to confirm: <span className="font-semibold text-white">{deleteExpectedName}</span>
              <input
                type="text"
                autoFocus
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                disabled={busy}
                className="mt-2 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3"
                aria-label="Type the full name to confirm deletion"
              />
            </label>
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" disabled={busy} onClick={() => { setPendingDelete(null); setDeleteConfirmName(""); }} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-bold text-slate-200 disabled:opacity-50">Cancel</button>
              <button type="button" disabled={busy || !deleteReady} onClick={() => void confirmDelete()} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy ? "Deleting…" : "Permanently Delete"}</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
