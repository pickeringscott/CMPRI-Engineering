'use client';
import {useCallback,useEffect,useState} from 'react';
import {getValidSession} from '@/lib/supabase/client';
type Status={checkedAt:string;enabled:boolean;integrationEnabled:boolean;pendingEvents:number;lastRun:string|null;lastError:string|null;error?:string;
 channels:{id:string;status:string;expires_at:string;sync_received_at:string|null}[];
 access?:{account?:string;folderName?:string;error?:string;accountVerified?:boolean;scopeMetadata?:{reported:boolean;recognized:string[]}};
 lastResult?:{insertedLines:number;ordersEnriched:number;held:{po?:string;fileId?:string;reason:string}[]}|null};
export default function DrivePoIntakePage(){
 const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const load=useCallback(async(checkAccess=false)=>{
  const session=await getValidSession();if(!session)throw Error('Sign in to CMPRI to view intake status.');
  const r=await fetch('/api/integrations/drive-po/control'+(checkAccess?'?checkAccess=1':''),{headers:{Authorization:`Bearer ${session.access_token}`},cache:'no-store'});
  const data=await r.json();if(!r.ok)throw Error(data.error||'Status unavailable');return data as Status;
 },[]);
 useEffect(()=>{let cancelled=false;load().then(data=>{if(!cancelled)setStatus(data);}).catch(e=>{if(!cancelled)setError(e.message);});return()=>{cancelled=true;};},[load]);
 async function action(activate:boolean){
  setBusy(true);setError('');
  try{
   if(activate){
    const session=await getValidSession();if(!session)throw Error('Sign in to CMPRI first.');
    const r=await fetch('/api/integrations/drive-po/control',{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'activate'})});
    const data=await r.json();if(!r.ok)throw Error(data.error||'Activation not confirmed.');
   }
   setStatus(await load(!activate));
  }catch(e){setError(e instanceof Error?e.message:'Request failed');}finally{setBusy(false);}
 }
 const active=status?.channels.find(c=>c.status==='active'&&Date.parse(c.expires_at)>Date.parse(status.checkedAt));
 return <main className="mx-auto max-w-4xl space-y-5 p-6">
  <h1 className="text-2xl font-semibold">Purchase order Drive intake</h1>
  <p>New PDFs in <a className="underline" href="https://drive.google.com/drive/folders/18V2KjCHw2o0uQCVFzu2GGxJ9PghGS7AD" target="_blank" rel="noreferrer">PO Downloads from iBuy</a> can supply missing items for existing matching orders. Conflicting or incomplete documents are held for review.</p>
  {error&&<p role="alert">{error}</p>}
  {status&&<>
   <p>{!status.integrationEnabled?'PO imports are disabled or in safe mode.':active?active.sync_received_at?'Drive has confirmed the notification channel.':'Watch registered; awaiting Drive confirmation.':'No active Drive watch.'}</p>
   {active&&<p>Watch expires: {new Date(active.expires_at).toLocaleString()}. Renewal is automatic.</p>}
   <p>Pending notifications: {status.pendingEvents}. Last completed run: {status.lastRun?new Date(status.lastRun).toLocaleString():'None'}.</p>
   {status.access&&<p>{status.access.error||`Access verified for ${status.access.account}: ${status.access.folderName}`}</p>}
   {status.access?.scopeMetadata&&<p>Google account verified: {status.access.accountVerified?'Yes':'Not yet'}. Drive scopes reported by existing token refresh: {status.access.scopeMetadata.reported?(status.access.scopeMetadata.recognized.join(', ')||'None'):'Not supplied by Google'}.</p>}
   {status.lastError&&<p role="alert">{status.lastError}</p>}
   <div className="flex gap-3">
    <button className="rounded border px-3 py-2" disabled={busy} onClick={()=>action(false)}>Check access and refresh</button>
    <button className="rounded border px-3 py-2" disabled={busy||!!active||!status.access?.account||!status.integrationEnabled} onClick={()=>action(true)}>Activate folder notifications</button>
   </div>
   {status.lastResult&&<>
    <p>Last run added {status.lastResult.insertedLines} items to {status.lastResult.ordersEnriched} orders.</p>
    <h2 className="text-xl font-semibold">Documents requiring review</h2>
    {status.lastResult.held.length?<table className="w-full text-left"><thead><tr><th>PO or source file</th><th>Reason</th></tr></thead><tbody>{status.lastResult.held.map((h,i)=><tr key={`${h.po||h.fileId}-${i}`}><td>{h.po||h.fileId}</td><td>{h.reason}</td></tr>)}</tbody></table>:<p>No held documents.</p>}
   </>}
  </>}
 </main>;
}
