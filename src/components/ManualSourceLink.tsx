"use client";
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {createClient,getValidSession} from '@/lib/supabase/client';

function privateSource(url:string){
  const parsed=new URL(url,window.location.origin);
  return parsed.origin===window.location.origin&&parsed.pathname==='/api/assets/documentation/source';
}

async function currentSource(url:string,signal:AbortSignal,userId?:string){
  if(!privateSource(url))return url;
  const parsed=new URL(url,window.location.origin);
  const session=await getValidSession();
  signal.throwIfAborted();
  if(!session?.access_token||(userId&&session.user.id!==userId))throw Error('Sign in again to open this source.');
  const response=await fetch(parsed.pathname+parsed.search,{headers:{Authorization:`Bearer ${session.access_token}`},cache:'no-store',signal});
  const result=await response.json();
  if(!response.ok)throw Error(result.error||'Source unavailable.');
  const after=await getValidSession();
  signal.throwIfAborted();
  if(after?.user.id!==session.user.id)throw Error('Your account changed. Reopen the guide before opening this source.');
  const opened=new URL(result.url);if(opened.protocol!=='https:')throw Error('Invalid source link.');
  opened.hash=parsed.hash;
  return opened.href;
}
export default function ManualSourceLink({href,children,className,userId}:{href:string;children:ReactNode;className?:string;userId?:string}){
  const scope=JSON.stringify([href,userId]);
  const [error,setError]=useState<{scope:string;message:string}|null>(null);
  const pending=useRef<AbortController|null>(null);
  useEffect(()=>()=>pending.current?.abort(),[href,userId]);
  return <><a href={href} className={className} target="_blank" rel="noreferrer" onClick={event=>{
    if(!privateSource(href))return;
    event.preventDefault();pending.current?.abort();setError(null);
    const opened=window.open('about:blank','_blank');
    if(!opened){setError({scope,message:'Allow this source window and try again.'});return;}
    opened.opener=null;
    const controller=new AbortController();pending.current=controller;
    const closePending=()=>opened.close();
    controller.signal.addEventListener('abort',closePending,{once:true});
    void currentSource(href,controller.signal,userId).then(url=>{
      if(controller.signal.aborted){opened.close();return;}
      opened.location.replace(url);
    }).catch(e=>{opened.close();if(!controller.signal.aborted)setError({scope,message:e instanceof Error?e.message:'Source unavailable.'});})
      .finally(()=>{controller.signal.removeEventListener('abort',closePending);if(pending.current===controller)pending.current=null;});
  }}>{children}</a>{error?.scope===scope&&<span role="alert" className="ml-2 text-xs text-amber-200">{error.message}</span>}</>;
}
export function ManualSourceFrame({href,title,userId}:{href:string;title:string;userId?:string}){
  const scope=JSON.stringify([href,userId]);
  const [open,setOpen]=useState(false);
  const [result,setResult]=useState<{scope:string;url?:string;error?:string}|null>(null);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    const subscription=userId?createClient().auth.onAuthStateChange((_event,session)=>{
      if(session?.user.id!==userId){controller.abort();setResult({scope,error:'Your account changed. Reopen the guide before opening this source.'});}
    }).data.subscription:undefined;
    void currentSource(href,controller.signal,userId).then(url=>{if(!controller.signal.aborted)setResult({scope,url});})
      .catch(e=>{if(!controller.signal.aborted)setResult({scope,error:e instanceof Error?e.message:'Source unavailable.'});});
    return()=>{controller.abort();subscription?.unsubscribe();};
  },[open,href,userId,scope]);
  const current=result?.scope===scope?result:null;
  return <details className="text-xs text-sky-300" onToggle={event=>{setResult(null);setOpen(event.currentTarget.open);}}><summary className="cursor-pointer">{title}</summary>{open&&(current?.error?<p role="alert">{current.error}</p>:current?.url?<iframe title={title} src={current.url} loading="lazy" className="h-64 w-full border-0"/>:<p>Opening original source…</p>)}</details>;
}
