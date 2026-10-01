type DashboardNotificationBellProps = {
  count: number;
  label: string;
  title?: string;
  onClick: () => void;
};

export default function DashboardNotificationBell({
  count,
  label,
  title,
  onClick,
}: DashboardNotificationBellProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title}
      className="relative grid size-5 shrink-0 place-items-center rounded-md border border-sky-400/50 bg-slate-800/80 text-sky-50 shadow-sm shadow-black/30 hover:border-sky-300 hover:bg-slate-700"
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 2.5a5 5 0 0 0-5 5v2.8L3.5 13.5h13L15 10.3V7.5a5 5 0 0 0-5-5Z" />
        <path d="M8 16a2 2 0 0 0 4 0" />
      </svg>
      {count > 0 && (
        <span className="absolute -right-1.5 -top-1.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-slate-950 bg-red-500 px-0.5 text-center text-[7pt] font-bold leading-none text-white shadow-sm shadow-black/50">{count}</span>
      )}
    </button>
  );
}
