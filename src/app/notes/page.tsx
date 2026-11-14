"use client";
import {useEffect,useRef,useState} from 'react';
import GeneralNotes from '@/components/GeneralNotes';
import ModalDashboardLink from '@/components/ModalDashboardLink';
import {loadCmpriSession,type CmpriClientSession} from '@/lib/auth/client-session';
import {createClient} from '@/lib/supabase/client';
import './notes.css';
export default function GeneralNotesPage(){
 const [session,setSession]=useState<CmpriClientSession|null>(null),[error,setError]=useState('Checking your CMPRI session…'),expected=useRef<CmpriClientSession|null>(null);
 useEffect(()=>{let live=true,generation=0,lastRefresh=0;
  const refresh=async()=>{if(Date.now()-lastRefresh<15_000)return;lastRefresh=Date.now();const request=++generation;try{const authorized=await loadCmpriSession();if(live&&request===generation){expected.current=authorized;setSession(authorized);setError('')}}catch{if(live&&request===generation){expected.current=null;setSession(null);setError('Sign in to CMPRI to use your notebook.')}}};
  void refresh();
  const {data}=createClient().auth.onAuthStateChange((event,auth)=>{if(event==='SIGNED_OUT'||(expected.current&&auth?.user.id!==expected.current.user.id)){generation++;expected.current=null;setSession(null);setError('Your session changed. Reopen Notes after signing in.')}});
  const resize=()=>document.documentElement.style.setProperty('--notes-visible-height',(window.visualViewport?.height||innerHeight)+'px');resize();window.visualViewport?.addEventListener('resize',resize);
  const wake=()=>{if(!document.hidden)void refresh()};window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
  return()=>{live=false;data.subscription.unsubscribe();window.visualViewport?.removeEventListener('resize',resize);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);document.documentElement.style.removeProperty('--notes-visible-height')};
 },[]);
 function finishClose(){if(window.parent!==window)window.parent.postMessage({type:'cmpri-modal-close',modalToken:new URLSearchParams(window.location.search).get('modalToken')||''},window.location.origin);else window.history.back()}
 useEffect(()=>{const ready=()=>{if(window.parent!==window)window.parent.postMessage({type:'cmpri-modal-close',modalToken:new URLSearchParams(window.location.search).get('modalToken')||''},window.location.origin);else window.history.back()};document.addEventListener('cmpri-notes-close-ready',ready);return()=>document.removeEventListener('cmpri-notes-close-ready',ready)},[]);
 function close(){if(document.dispatchEvent(new Event('cmpri-modal-cancel-request',{cancelable:true})))finishClose()}
 return <main className="general-notes-host"><header className="general-notes-page-header" data-cmpri-page-heading><h1>Notes</h1><div className="flex items-center gap-2"><ModalDashboardLink className="text-xs"/><button type="button" data-cmpri-modal-close="true" aria-label="Close Notes" onClick={close}>×</button></div></header>{session?<GeneralNotes key={session.hotelId+':'+session.user.id} scope={{hotelId:session.hotelId,userId:session.user.id}}/>:<p className="general-notes-auth" role="status">{error}</p>}</main>;
}
