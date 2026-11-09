"use client";

type OpenTicket = { key: string; title: string };

/** Keeps the list and open tickets reachable while other desktop windows are on top. */
export default function WorkOrderWindowSwitcher({
  tickets, activeKey, listKey, onOpenList, onRaise,
}: {
  tickets: OpenTicket[];
  activeKey: string;
  listKey: string;
  onOpenList: () => void;
  onRaise: (key: string) => void;
}) {
  const activeTicket = tickets.some(ticket => ticket.key === activeKey) ? activeKey : "";
  return (
    <nav aria-label="Work order windows" className="flex w-full min-w-0 items-center gap-2">
      <button
        type="button"
        aria-pressed={activeKey === listKey}
        onClick={onOpenList}
        className="min-h-9 shrink-0 rounded-lg border border-amber-500/60 bg-slate-900 px-3 text-xs font-semibold text-amber-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
      >Work order list</button>
      {tickets.length > 0 && (
        <select
          aria-label="Switch open work order"
          value={activeTicket}
          onChange={event => { if (event.target.value) onRaise(event.target.value); }}
          className="min-h-9 min-w-0 max-w-sm flex-1 rounded-lg border border-slate-600 bg-slate-900 px-2 text-xs text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
        >
          <option value="">Open work orders ({tickets.length})</option>
          {tickets.map(ticket => <option key={ticket.key} value={ticket.key}>{ticket.title}</option>)}
        </select>
      )}
    </nav>
  );
}
