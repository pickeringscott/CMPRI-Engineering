import { roleDisplayName } from "@/lib/account-display";

type AccountSummaryUser = {
  name: string | null;
  email: string | null;
  role: string;
  secondary_roles?: string[];
};

export default function AccountSummary({ user }: { user: AccountSummaryUser }) {
  const displayRole = roleDisplayName(user.role, user.secondary_roles);
  const submitOnly = ["Front Desk", "Front Desk Manager", "Lead Housekeeper"].includes(displayRole);

  return (
    <div role="group" aria-label="Signed-in account" className="flex min-w-0 flex-col items-start gap-y-1 text-xs text-slate-400">
      <span className={submitOnly ? "text-[14pt] font-semibold tracking-tight text-amber-400" : "text-[14pt] font-semibold tracking-tight text-slate-100"}>{user.name?.trim() || "Name not set"}</span>
      {!submitOnly && <span className="text-[9pt] font-medium text-sky-200/90">{displayRole}</span>}
      {!submitOnly && user.email && <span>{user.email}</span>}
    </div>
  );
}