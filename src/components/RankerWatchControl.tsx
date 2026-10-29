"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {createClient,getValidSession} from '@/lib/supabase/client';
type Channel={status:string;expires_at:string;sync_received_at?:string|null};
export default function RankerWatchControl(){
 const [allowed,setAllowed]=useState(false),[busy,setBusy]=useState(false),[canActivate,setCanActivate]=useState(false),[message,setMessage]=useState('');
 const generation=useRef(0),inFlight=useRef(false);
 const check=useCallback(async()=>{
  const version=++generation.current;setCanActivate(false);
  try{const session=await getValidSession();if(!session){setAllowed(false);return;}
   const response=await fetch('/api/integrations/room-ranker/watch',{headers:{Authorization:`Bearer ${session.access_token}`},cache:'no-store'});
   if(version!==generation.current)return;
   if(response.status===403){setAllowed(false);return;}
   if(!response.ok){setMessage('Notification status unavailable. Check status before enabling.');return;}
   const data=await response.json();if(version!==generation.current)return;
   setAllowed(true);const current=(data.channels as Channel[]).filter(c=>Date.parse(c.expires_at)>Date.now());
   const active=current.find(c=>c.status==='active'),pending=current.some(c=>c.status==='pending');
   setCanActivate(!active&&!pending);
   setMessage(active?active.sync_received_at?'Spreadsheet change notifications enabled and confirmed by Google Drive.':'Spreadsheet change notifications registered; awaiting Google Drive confirmation.':pending?'Registration pending verification. Do not retry activation.':'Spreadsheet change notifications are not enabled.');
  }catch{if(version===generation.current)setMessage('Notification status unavailable. Check status before enabling.');}
 },[]);
 useEffect(()=>{let mounted=true;queueMicrotask(()=>{if(mounted)void check();});const {data}=createClient().auth.onAuthStateChange(()=>{generation.current++;setAllowed(false);setCanActivate(false);queueMicrotask(()=>void check());});return()=>{mounted=false;generation.current++;data.subscription.unsubscribe();};},[check]);
 async function activate(){
  if(inFlight.current||!canActivate)return;inFlight.current=true;setBusy(true);setCanActivate(false);const version=generation.current;
  try{const session=await getValidSession();if(!session){setAllowed(false);return;}
   const response=await fetch('/api/integrations/room-ranker/watch',{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'activate'})});
   const result=await response.json();if(version!==generation.current)return;
   if(!response.ok){setMessage(result.error||'Registration unconfirmed. Check status before another attempt.');return;}
   if(result.status==='safe-mode'||result.status==='disabled'){setMessage('Spreadsheet change notifications are disabled by the existing integration configuration.');return;}
   await check();
  }catch{if(version===generation.current)setMessage('Registration outcome unconfirmed. Check status before another attempt.');}
  finally{inFlight.current=false;setBusy(false);}
 }
 if(!allowed)return null;
 return <section aria-label="Spreadsheet change notifications" className="border-b border-slate-200 px-2 py-1 text-xs">
  <p role="status">{message}</p>
  <button className="mr-2 rounded border px-2 py-1 disabled:opacity-50" disabled={busy||!canActivate} onClick={()=>void activate()}>Enable spreadsheet change notifications</button>
  <button className="rounded border px-2 py-1" disabled={busy} onClick={()=>void check()}>Check notification status</button>
 </section>;
}
