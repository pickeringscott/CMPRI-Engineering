"use client";
/** Shared actual selection controls for current and source-recorded inspections. */
export default function PmAnswerControls({ value, onChange, disabled = false, log = false, label, historicalCompleted = false }: {
  value: string; onChange?: (value: string) => void; disabled?: boolean; log?: boolean; label: string; historicalCompleted?: boolean;
}) {
  const options = log ? [['YES','Yes'],['NO','No']] : [['complete','✓ OK'],['follow-up','/ Follow-up'],['na','N/A']];
  return <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
    {historicalCompleted && !value && <button type="button" disabled aria-pressed="true" className="rounded-md border border-slate-400 bg-slate-800 px-2 py-1.5 text-[11px] font-bold text-slate-100">Completed historically · condition unrecorded</button>}
    {options.map(([state, text]) => <button key={state} type="button" aria-pressed={value === state}
      disabled={disabled || !onChange} onClick={() => onChange?.(state)}
      className={`rounded-md border px-2 py-1.5 text-[11px] font-bold ${value === state
        ? state === 'follow-up' || state === 'NO' ? 'border-amber-400 bg-amber-950 text-amber-100' : 'border-emerald-400 bg-emerald-950 text-emerald-100'
        : 'border-slate-700 text-slate-400'} disabled:cursor-default`}>{text}</button>)}
  </div>;
}
