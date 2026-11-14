"use client";
import {useEffect,useState} from 'react';
import GeneralNotes from '@/components/GeneralNotes';
import ModalDashboardLink from '@/components/ModalDashboardLink';
import type {CmpriClientSession} from '@/lib/auth/client-session';
import {NotesSessionGuard} from '@/lib/general-notes-session';
import {createClient,getValidSession} from '@/lib/supabase/client';
import './notes.css';
export default function GeneralNotesPage(){
 const [session,setSession]=useState<CmpriClientSession|null>(null),[error,setError]=useState('Checking your CMPRI session…');
 useEffect(()=>{
  const guard=new NotesSessionGuard(async()=>{const token=await getValidSession();if(!token?.access_token)return {kind:'missing'};const response=await fetch('/api/session',{headers:{Authorization:`Bearer ${token.access_token}`},cache:'no-store'});if(response.status===401||response.status===403)return {kind:'denied'};if(!response.ok)throw Error('Session check unavailable');const authorized=await response.json() as CmpriClientSession;if(!authorized.user?.id||!authorized.hotelId)throw Error('Incomplete session');return {kind:'authorized',session:authorized}},(authorized,message)=>{setSession(authorized);setError(message)});
  void guard.refresh();
  const {data}=createClient().auth.onAuthStateChange((event,auth)=>guard.authChanged(event,auth?.user.id));
  const resize=()=>document.documentElement.style.setProperty('--notes-visible-height',(window.visualViewport?.height||innerHeight)+'px');resize();window.visualViewport?.addEventListener('resize',resize);
  const wake=()=>{if(!document.hidden)void guard.refresh()};window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);window.addEventListener('online',wake);
  return()=>{guard.stop();data.subscription.unsubscribe();window.visualViewport?.removeEventListener('resize',resize);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);window.removeEventListener('online',wake);document.documentElement.style.removeProperty('--notes-visible-height')};
 },[]);
 function finishClose(){if(window.parent!==window)window.parent.postMessage({type:'cmpri-modal-close',modalToken:new URLSearchParams(window.location.search).get('modalToken')||''},window.location.origin);else window.history.back()}
 useEffect(()=>{const ready=()=>{if(window.parent!==window)window.parent.postMessage({type:'cmpri-modal-close',modalToken:new URLSearchParams(window.location.search).get('modalToken')||''},window.location.origin);else window.history.back()};document.addEventListener('cmpri-notes-close-ready',ready);return()=>document.removeEventListener('cmpri-notes-close-ready',ready)},[]);
 function close(){if(document.dispatchEvent(new Event('cmpri-modal-cancel-request',{cancelable:true})))finishClose()}
 return <main className="general-notes-host"><header className="general-notes-page-header" data-cmpri-page-heading><h1>Notes</h1><div className="flex items-center gap-2"><ModalDashboardLink className="text-xs"/><button type="button" data-cmpri-modal-close="true" aria-label="Close Notes" onClick={close}>×</button></div></header>{session&&error&&<p className="general-notes-session-notice" role="alert">{error}</p>}{session?<GeneralNotes key={session.hotelId+':'+session.user.id} scope={{hotelId:session.hotelId,userId:session.user.id}}/>:<p className="general-notes-auth" role="status">{error}</p>}</main>;
}
