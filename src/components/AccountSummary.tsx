import { roleDisplayName } from "@/lib/account-display";

type AccountSummaryUser = {
  name: string | null;
  email: string | null;
  role: string;
};

export default function AccountSummary({ user }: { user: AccountSummaryUser }) {
  const displayRole = roleDisplayName(user.role);
  const submitOnly = displayRole === "Front Desk" || displayRole === "Lead Housekeeper";

  return (
    <div role="group" aria-label="Signed-in account" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
      <span className={submitOnly ? "text-2xl font-semibold text-amber-400" : "font-semibold text-slate-200"}>{user.name?.trim() || "Name not set"}</span>
      {!submitOnly && user.email && <span>{user.email}</span>}
      {!submitOnly && <span className="rounded-full border border-sky-500/40 bg-sky-950/30 px-2 py-0.5 font-semibold text-sky-200">{displayRole}</span>}
    </div>
  );
}