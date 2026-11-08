"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { useOnlineUsers, presenceKey } from "@/components/UserPresence";
import SearchableSelect from "@/components/SearchableSelect";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import useEmbeddedModal from "@/components/use-embedded-modal";
import { accountRoleDisplayName, roleDisplayName } from "@/lib/account-display";

type UserRow = { id: string; email: string | null; full_name: string | null; role: string | null; secondary_roles?: string[]; active: boolean | null; can_manage: boolean; last_sign_in_at?: string | null; waiting_for_verification?: boolean | null };

export default function UserManagementPage() {
  const onlineUsers = useOnlineUsers();
  const embedded = useEmbeddedModal();
  const router = useRouter();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [presenceKeys, setPresenceKeys] = useState<Record<string, string>>({});
  useEffect(() => {
    let current = true;
    void Promise.all(users.map(async (user) => [user.id, await presenceKey(user.id)] as const)).then((entries) => { if (current) setPresenceKeys(Object.fromEntries(entries)); });
    return () => { current = false; };
  }, [users]);

  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [password, setPassword] = useState("");
  const [setPasswordMode, setSetPasswordMode] = useState(false);
  const [busy, setBusy] = useState(false);
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
      setUsers((rows) => rows.map((row) => (row.id === user.id ? { ...row, ...payload.user } : row)));
    } catch { setMessage("The account update could not be confirmed. Reload to check its status."); }
    finally { setBusy(false); }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto w-full px-4 py-8 sm:px-6">
        {!embedded && <div className="mt-4 flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-400">Management</p>
            <h1 className="mt-2 text-3xl font-bold">User Management</h1>
            <p className="mt-2 text-sm text-slate-400">Invite users, assign roles, or deactivate access. Deactivated accounts retain their CMPRI history.</p>
          </div>
          <div className="flex items-center gap-3"><span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-bold">{users.filter((u) => u.active === true).length} active</span><ModalDashboardLink className="text-sm font-semibold text-amber-400">← Dashboard</ModalDashboardLink></div>
        </div>}
        {embedded && <div className="mb-4 flex items-center justify-end gap-3">
          <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-bold">{users.filter((u) => u.active === true).length} active</span>
          <ModalDashboardLink className="text-sm font-semibold text-amber-400">← Dashboard</ModalDashboardLink>
        </div>}
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
              <input required disabled={busy} minLength={10} maxLength={128} type="password" autoComplete="new-password" aria-label="Temporary password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Temporary password (10+ characters)" className="min-h-11 min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3 sm:col-span-2" />
            )}
            <button disabled={busy || !roles.includes(role)} className="rounded-lg bg-amber-400 px-4 py-2 font-bold text-slate-950 disabled:opacity-50 sm:col-span-2">{busy ? "Saving…" : setPasswordMode ? "Create User With Password" : "Invite User"}</button>
          </form>
        )}
        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900">
          <div className="border-b border-slate-800 px-5 py-4"><h2 className="text-xl font-bold">Users</h2></div>
          {loading ? <p className="p-5 text-slate-400">Loading…</p> : users.map((user) => (
            <div key={user.id} className="grid gap-3 border-b border-slate-800 px-5 py-4 md:grid-cols-[1fr_220px_150px] md:items-center">
              <div className="min-w-0">
                <p className="break-words font-semibold">{user.full_name || "Unnamed user"}</p>
                {user.can_manage && <p className="text-xs text-sky-200">{accountRoleDisplayName(user)}</p>}
                <p className="mt-1 break-all text-sm text-slate-300">{user.email || "No email on file"}</p>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                  <span>{user.active === true ? "Active" : "Deactivated"} · {user.waiting_for_verification === true ? "Waiting for verification" : user.last_sign_in_at ? `Last sign-in: ${new Date(user.last_sign_in_at).toLocaleString()}` : user.waiting_for_verification === false ? "Never signed in" : "Sign-in unavailable"}</span>
                  {user.active === true && onlineUsers.has(presenceKeys[user.id]) && <span role="img" aria-label="Currently online" title="Currently online" className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500" />}
                </p>
              </div>
              {user.can_manage ? (
                <div className="min-w-0">
                  <span className="text-xs text-slate-500">Authorization role</span>
                  <SearchableSelect value={user.role || ""} onChange={(value) => void updateUser(user, { role: value })} options={roles.includes(user.role || "") ? roleOptions : [{ value: user.role || "", label: roleDisplayName(user.role || "Unassigned") }, ...roleOptions]} placeholder={`Role for ${user.full_name || "user"}`} disabled={busy} />
                  {Boolean(user.secondary_roles?.length) && <p className="mt-1 text-xs text-slate-500">{roleDisplayName(user.secondary_roles || [])}</p>}
                </div>
              ) : (
                <p className="text-sm text-slate-400">{accountRoleDisplayName(user)}</p>
              )}
              {user.can_manage ? (
                <button disabled={busy} onClick={() => void updateUser(user, { active: user.active !== true })} className={`rounded-lg border px-3 py-2 text-sm font-bold disabled:opacity-50 ${user.active !== true ? "border-emerald-500/50 text-emerald-200" : "border-red-500/50 text-red-200"}`}>{user.active !== true ? "Reactivate" : "Deactivate"}</button>
              ) : (
                <span className="text-xs text-slate-500">View only</span>
              )}
            </div>
          ))}
        </section>
      </div>

    </main>
  );
}
