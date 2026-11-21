"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";


type OpenTicket = { key: string; title: string };

/** Keeps open tickets reachable while other desktop windows are on top. */
export default function WorkOrderWindowSwitcher({
  tickets, activeKey, onRaise,
}: {
  tickets: OpenTicket[];
  activeKey: string;
  onRaise: (key: string) => void;
}) {
  const { t } = useUiLanguage();
  const activeTicket = tickets.some(ticket => ticket.key === activeKey) ? activeKey : "";
  if (!tickets.length) return null;
  return (
    <nav aria-label={t("Work order windows")} className="flex w-full min-w-0 items-center gap-2">
        <select
          aria-label={t("Switch open work order")}
          value={activeTicket}
          onChange={event => { if (event.target.value) onRaise(event.target.value); }}
          className="min-h-9 min-w-0 max-w-sm flex-1 rounded-lg border border-slate-600 bg-slate-900 px-2 text-xs text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
        >
          <option value="">{t("Open work orders (")}{tickets.length})</option>
          {tickets.map(ticket => <option key={ticket.key} value={ticket.key}>{t(ticket.title)}</option>)}
        </select>
    </nav>
  );
}
