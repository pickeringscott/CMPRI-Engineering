'use client';
import { useState } from 'react';
import type { RecordedIssueSource } from '@/lib/pm/recorded-issues';
import { pmIssueExternalId, pmTicketClosed, type PmIssueLink } from '@/lib/pm/issues';
import { getValidSession } from '@/lib/supabase/client';
import PmIssueDialog from './PmIssueDialog';

export default function PmRecordedIssues({locations, links, onLinked, onOpen, onHistory}: {
  locations: {id:string;name:string;room_number?:string|null}[]; links: PmIssueLink[];
  onLinked:(link:PmIssueLink)=>void; onOpen:(id:string)=>void; onHistory:()=>void;
}) {
  const [open,setOpen] = useState(false);
  const [busy,setBusy] = useState(false);
  const [records,setRecords] = useState<RecordedIssueSource[]>([]);
  const [source,setSource] = useState<RecordedIssueSource|null>(null);
  const [canConfirm,setCanConfirm] = useState(false);
  const [review,setReview] = useState(false);
  const [error,setError] = useState('');
  const [details,setDetails] = useState<Record<string,{selected:boolean;detail:string;locationId:string}>>({});
  const [results,setResults] = useState<Record<string,{id?:string;error?:string}>>({});
  async function headers() {
    const session = await getValidSession();
    if (!session?.access_token) throw new Error('Sign in again before reviewing recorded issues.');
    return {Authorization:`Bearer ${session.access_token}`, 'Content-Type':'application/json'};
  }
  async function load() {
    setOpen(true);setBusy(true);setError('');setReview(false);setSource(null);
    try {
      const response = await fetch('/api/preventive-maintenance/recorded-issues',{headers:await headers(),cache:'no-store'});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Recorded issues unavailable.');
      setRecords(data.records);setCanConfirm(data.canConfirm);
    } catch(cause) {setError(cause instanceof Error ? cause.message : 'Recorded issues unavailable.');}
    finally {setBusy(false);}
  }
  function select(record:RecordedIssueSource) {
    setSource(record);setReview(false);setError('');setResults({});
    setDetails(Object.fromEntries(record.issues.map(issue=>[issue.key,{selected:false,detail:issue.detail,locationId:issue.locationId}])));
  }
  const sourceRoom = source?.scope.match(/^room:(\d{2,4})$/)?.[1];
  const ticketLocations = sourceRoom ? locations.filter(location=>String(location.room_number || '').trim()===sourceRoom || location.name.match(/\b\d{2,4}\b/)?.[0]===sourceRoom) : locations;
  const selected = source?.issues.filter(issue=>details[issue.key]?.selected) || [];
  const linked = (key:string) => source && links.find(link=>link.import_external_id===pmIssueExternalId(source.templateId,source.period,source.scope,key));
  async function confirm() {
    if (!source || !review || busy || source.hold || !canConfirm || !selected.length) return;
    setBusy(true);setError('');
    try {
      const authHeaders = await headers();
      for (const issue of selected) {
        if (linked(issue.key) || results[issue.key]?.id) continue;
        try {
          const response = await fetch('/api/work-orders',{method:'POST',headers:authHeaders,body:JSON.stringify({orders:[{}],pm_submission:{
            confirmed:true, recordedSource:{kind:source.kind,id:source.id},fingerprint:source.fingerprint,
            issueKey:issue.key, detail:details[issue.key].detail,locationId:details[issue.key].locationId,
          }})});
          const data = await response.json();const order = data.work_orders?.[0];
          if (!response.ok || !order?.id) throw new Error(data.error || 'Ticket confirmation failed.');
          setResults(current=>({...current,[issue.key]:{id:order.id}}));
          onLinked({...order,import_external_id:pmIssueExternalId(source.templateId,source.period,source.scope,issue.key)});
        } catch(cause) {setResults(current=>({...current,[issue.key]:{error:cause instanceof Error?cause.message:'Ticket confirmation failed.'}}));}
      }
    } catch(cause) {setError(cause instanceof Error?cause.message:'Confirmation unavailable.');}
    finally {setBusy(false);}
  }
  return <>
    <button type="button" className="my-2 rounded border border-slate-600 px-3 py-2 text-sm" onClick={()=>void load()}>Review issues from previous inspections</button>
    {open && <PmIssueDialog label="Previous inspection issues" busy={busy} onDismiss={()=>setOpen(false)}><section className="rounded-xl border border-slate-600 bg-slate-950 p-4 space-y-3">
      <h2 className="font-bold">Previous inspection issues</h2>
      <p className="text-sm">Review recorded issues without redoing or saving the inspection. Ticket descriptions and locations entered here apply only to confirmed work orders. No tickets are created by opening this list.</p>
      {error && <p role="alert" className="text-red-300">{error}</p>}
      {busy && <p role="status">Working…</p>}
      {!source ? <>
        <p className="text-xs text-slate-300">All recorded years; selected week does not limit this list. Ordinary No, N/A, blank and unchecked answers are not automatically defects.</p>
        {!busy && !records.length && !error && <p>No automatically identifiable recorded issues.</p>}
        {records.map(record=><button type="button" key={`${record.kind}:${record.id}`} onClick={()=>select(record)} className="block w-full rounded border border-slate-700 p-2 text-left"><strong>{record.title}</strong><span className="block text-sm">{record.period} · {record.scope} · {record.issues.length} recorded issues</span>{record.hold && <span className="block text-xs text-amber-200">Source reconciliation required</span>}</button>)}
        <p className="text-sm text-amber-200">Separate retained maintenance views can contain ambiguous periods, grouped equipment or overlapping answers. Those are not silently assigned ticket identities by this list.</p>
        <button type="button" onClick={()=>{setOpen(false);onHistory();}} className="underline">View retained maintenance records and unresolved notes</button>
      </> : <>
        <h3 className="font-semibold">{source.title} · {source.period} · {source.scope}</h3>
        <p className="whitespace-pre-wrap text-sm">{source.notes}</p>
        {sourceRoom && !ticketLocations.length && <p role="alert">No active location matches recorded Room {sourceRoom}. This issue cannot be submitted under a different room.</p>}
        {source.hold && <p role="alert" className="text-amber-200">{source.hold}</p>}
        {!canConfirm && <p>Current permissions allow viewing only, not ticket creation.</p>}
        {(review?selected:source.issues).map(issue=>{
          const existing = linked(issue.key);const result = results[issue.key];const value = details[issue.key];
          return <div key={issue.key} className="border-t border-slate-700 pt-2 space-y-2">
            <label className="flex gap-2"><input type="checkbox" checked={value.selected} disabled={busy||review||!!existing||!!source.hold||!canConfirm} onChange={event=>setDetails(current=>({...current,[issue.key]:{...current[issue.key],selected:event.target.checked}}))}/><strong>{issue.label}</strong></label>
            {existing || result?.id ? <button type="button" className="text-emerald-300" onClick={()=>onOpen(existing?.id||result!.id!)}>Linked — open work order{pmTicketClosed(existing || undefined) && <span className="block text-xs">Ticket closed — original inspection result retained</span>}</button> : review ? <><p>{locations.find(location=>location.id===value.locationId)?.name}</p><p className="whitespace-pre-wrap">{value.detail}</p></> : <>
              <label className="block text-sm">Ticket issue description<textarea aria-label={`Ticket description: ${issue.label}`} value={value.detail} maxLength={10000} disabled={busy||!!source.hold||!canConfirm} className="block w-full rounded bg-slate-800 p-2" onChange={event=>setDetails(current=>({...current,[issue.key]:{...current[issue.key],detail:event.target.value}}))}/></label>
              <label className="block text-sm">Ticket location<select aria-label={`Ticket location: ${issue.label}`} value={value.locationId} disabled={busy||!!source.hold||!canConfirm} className="block w-full rounded bg-slate-800 p-2" onChange={event=>setDetails(current=>({...current,[issue.key]:{...current[issue.key],locationId:event.target.value}}))}><option value="">Select recorded issue location</option>{ticketLocations.map(location=><option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
            </>}
            {result?.error && <p role="alert" className="text-red-300">{result.error}</p>}
          </div>;
        })}
        <p className="text-xs">Successful tickets remain linked if another fails. Retry does not create another ticket for a linked issue. Inspection answers, completion and notes remain unchanged.</p>
      </>}
      <footer className="sticky bottom-0 bg-slate-950 py-2 flex flex-wrap gap-3">
        <button disabled={busy} onClick={()=>setOpen(false)}>Close</button>
        {source && <button disabled={busy} onClick={()=>review?setReview(false):setSource(null)}>{review?'Back to details':'Back to records'}</button>}
        {source && !source.hold && canConfirm && <button className="rounded bg-emerald-400 p-2 text-slate-950" disabled={busy||!selected.length||selected.some(issue=>!details[issue.key].detail.trim()||!details[issue.key].locationId)||selected.every(issue=>linked(issue.key)||results[issue.key]?.id)} onClick={()=>review?void confirm():setReview(true)}>{review?'Confirm selected work orders / retry unresolved':'Review selected work orders'}</button>}
      </footer>
    </section></PmIssueDialog>}
  </>;
}
