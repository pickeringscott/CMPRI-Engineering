"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {getValidSession} from '@/lib/supabase/client';
import {sharedFetch} from '@/lib/events/shared-fetch';
import {subscribeResource} from '@/lib/events/browser';
import GssScorecard from './GssScorecard';
import type {GssReport} from '@/lib/integrations/gss-publication';
export default function GssLive(){
 const [reports,setReports]=useState<GssReport[]>([]),[canRefresh,setCanRefresh]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef(0),mounted=useRef(false);
 const load=useCallback(async()=>{
  const current=++generation.current,session=await getValidSession();if(!session||!mounted.current)return;
  try{
   const response=await sharedFetch('/api/engineering/gss',{headers:{Authorization:`Bearer ${session.access_token}`},cache:'no-store'});
   if(!response.ok)throw Error('Saved GSS updates unavailable; showing the last report.');
   const data=await response.json(),latest=await getValidSession();
   if(!mounted.current||current!==generation.current||latest?.user.id!==session.user.id)return;
   setReports(data.reports||[]);setCanRefresh(data.canRefresh===true);setError('');
  }catch(e){if(mounted.current&&current===generation.current)setError(e instanceof Error?e.message:'Report unavailable');}
 },[]);
 useEffect(()=>{mounted.current=true;const stop=subscribeResource('gss',reason=>{if(reason==='reset'){generation.current++;setReports([]);setCanRefresh(false);setError('');}else{void load();}});return()=>{mounted.current=false;generation.current++;stop();};},[load]);
 async function refresh(){
  setBusy(true);try{const session=await getValidSession();if(!session)throw Error('Sign in required');const response=await sharedFetch('/api/engineering/gss',{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`}});if(!response.ok)throw Error('Source verification failed or another publication is running; previous report retained.');await load();}catch(e){setError(e instanceof Error?e.message:'Refresh failed');}finally{setBusy(false);}
 }
 return <>{canRefresh&&<button disabled={busy} onClick={()=>void refresh()} className="my-2 rounded border px-3 py-1">{busy?'Verifying source…':'Refresh GSS report'}</button>}{error&&<p role="status">{error}</p>}<GssScorecard publications={reports}/></>;
}
