import { roleDisplayName } from "@/lib/account-display";

type AccountSummaryUser = {
  name: string | null;
  email: string | null;
  role: string;
};

export default function AccountSummary({ user, displayName, hideEmail = false }: {
  user: AccountSummaryUser;
  displayName?: string | null;
  hideEmail?: boolean;
}) {
  const displayRole = roleDisplayName(user.role);
  const showRole = displayRole !== "Front Desk" && displayRole !== "Lead Housekeeper";

  return (
    <div role="group" aria-label="Signed-in account" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
      <span className="font-semibold text-slate-200">{displayName?.trim() || user.name?.trim() || "Name not set"}</span>
      {!hideEmail && user.email && <span>{user.email}</span>}
      {showRole && <span className="rounded-full border border-sky-500/40 bg-sky-950/30 px-2 py-0.5 font-semibold text-sky-200">{displayRole}</span>}
    </div>
  );
}