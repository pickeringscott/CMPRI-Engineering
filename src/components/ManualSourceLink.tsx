"use client";
import {useEffect,useState,type ReactNode} from 'react';
import {getValidSession} from '@/lib/supabase/client';

async function currentSource(url:string){
  const parsed=new URL(url,window.location.origin);
  if(parsed.origin!==window.location.origin||parsed.pathname!=='/api/assets/documentation/source')return url;
  const session=await getValidSession();
  if(!session?.access_token)throw Error('Sign in again to open this source.');
  const response=await fetch(parsed.pathname+parsed.search,{headers:{Authorization:`Bearer ${session.access_token}`},cache:'no-store'});
  const result=await response.json();
  if(!response.ok)throw Error(result.error||'Source unavailable.');
  const opened=new URL(result.url);if(opened.protocol!=='https:')throw Error('Invalid source link.');
  return opened.href+parsed.hash;
}
export default function ManualSourceLink({href,children,className}:{href:string;children:ReactNode;className?:string}){
  const [error,setError]=useState('');
  return <><a href={href} className={className} target="_blank" rel="noreferrer" onClick={event=>{
    if(!href.startsWith('/api/assets/documentation/source'))return;
    event.preventDefault();setError('');const opened=window.open('about:blank','_blank');
    if(opened)opened.opener=null;
    void currentSource(href).then(url=>{if(opened)opened.location.replace(url);else setError('Allow this source window and try again.');}).catch(e=>{opened?.close();setError(e.message);});
  }}>{children}</a>{error&&<span role="alert" className="ml-2 text-xs text-amber-200">{error}</span>}</>;
}
export function ManualSourceFrame({href,title}:{href:string;title:string}){
  const [open,setOpen]=useState(false),[source,setSource]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let active=true;if(open)void currentSource(href).then(url=>{if(active)setSource(url);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[open,href]);
  return <details className="text-xs text-sky-300" onToggle={e=>{setSource('');setError('');setOpen(e.currentTarget.open);}}><summary className="cursor-pointer">{title}</summary>{open&&(error?<p role="alert">{error}</p>:source?<iframe title={title} src={source} loading="lazy" className="h-64 w-full border-0"/>:<p>Opening original source…</p>)}</details>;
}
