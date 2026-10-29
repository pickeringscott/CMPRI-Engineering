"use client";
import type { RecordedPmForm } from '@/lib/pm/recorded-forms';
import PmAnswerControls from './PmAnswerControls';

export default function PmRecordedForms({ forms, page }: { forms: RecordedPmForm[]; page: number }) {
  return <section aria-label={`Recorded inspection controls, source page ${page}`} className="space-y-3">
    {forms.map(form => <details key={form.id} className="rounded border border-slate-600 p-3">
      <summary className="cursor-pointer font-semibold">Recorded {form.kind === 'log' ? 'inspection log' : 'checklist'} · {form.period} · {form.rows.filter(row => row.value).length} answers</summary>
      <p className="my-2 text-xs text-slate-400">Source page {page}. These are the recorded marks, not a new inspection or confirmation that defects were repaired. Missing dates remain unknown. Your current entries are unchanged.</p>
      <div className="divide-y divide-slate-700">{form.rows.map(row => <div key={row.id} className="py-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><span>{row.label}</span>
          <PmAnswerControls label={row.label} value={row.value} log={form.kind === 'log'} disabled />
        </div>
        {!row.value && <p className="text-xs text-slate-400">No unambiguous item answer recorded.</p>}
        {row.rawDate && <p className="text-xs text-slate-400">Source date: {row.rawDate}</p>}
        {row.notes && <p className="whitespace-pre-wrap text-sm text-amber-200">{row.notes}</p>}
      </div>)}</div>
    </details>)}
  </section>;
}
