"use client";
import { useEffect, useState } from 'react';
import { getValidSession } from '@/lib/supabase/client';
import PmAnswerControls from './PmAnswerControls';

/** Retained recorded values, separate from current editable inspection records. */
export default function PmMaintenanceHistory({ templateId }: { templateId?: string; canReview?: boolean }) {
  const [history, setHistory] = useState<typeof import('@/lib/pm/retained-maintenance-history.json')>({groups:[]});
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await getValidSession();
        if (!session?.access_token) throw new Error('Sign in again.');
        const response = await fetch('/api/preventive-maintenance/maintenance-history', {headers:{Authorization:`Bearer ${session.access_token}`},cache:'no-store'});
        if (!response.ok) throw new Error('Maintenance history could not be loaded.');
        const result = await response.json();
        if(active) setHistory(result);
      } catch(cause) { if(active) setError(cause instanceof Error ? cause.message : 'Maintenance history could not be loaded.'); }
    })();
    return () => { active = false; };
  }, []);
  const groups = history.groups.filter(group => (!templateId || group.templateId === templateId)
    && (group.forms.length || group.findings.length || group.unresolved.length || group.observations));
  return <section className="my-4 space-y-3" aria-label="Recorded maintenance history">
    <h3 className="text-lg font-bold">Recorded maintenance history</h3>
    {error && <p role="alert">{error}</p>}
    <p className="text-sm text-slate-400">Prior recorded values and maintenance notes. These do not change current inspections or confirm that defects were repaired.</p>
    {groups.map(group => <details key={group.id} className="rounded border border-slate-700 p-3">
      <summary className="cursor-pointer font-semibold">{group.category} · {group.location || 'Location unspecified'}</summary>
      {group.recordedDate && <p className="text-xs">Recorded date: {group.recordedDate}</p>}
      {group.observations && <p className="my-2 whitespace-pre-wrap text-sm">{group.observations}</p>}
      {group.forms.map(form => <details key={form.id} className="my-2 rounded border border-slate-600 p-2">
        <summary>{form.kind === 'log' ? 'Inspection log' : 'Checklist'} · {form.period || 'Period unspecified'} · {form.rows.filter(row => row.value).length} answers</summary>
        {form.rows.map(row => <div key={row.id} className="border-b border-slate-700 py-2">
          <span>{row.label}</span><PmAnswerControls label={row.label} value={row.value} log={form.kind === 'log'} disabled />
          {row.rawDate && <p className="text-xs">Recorded date: {row.rawDate}</p>}
          {!row.value && <p className="text-xs">No unambiguous answer recorded.</p>}
          {row.notes && <p className="whitespace-pre-wrap text-sm text-amber-200">{row.notes}</p>}
        </div>)}
      </details>)}
      {[...group.findings, ...group.unresolved].map((note, index) => <p key={index} className="my-2 whitespace-pre-wrap text-sm text-amber-200">{note}</p>)}
    </details>)}
  </section>;
}
