"use client";
import {useEffect,useRef,useState} from 'react';
import {mountApprovedMenus} from '@/lib/ui/approved-header-menus';
import {headerActionStyle} from '@/lib/ui/header-palette';
import {normalizeHeaderLayout,type HeaderLayout} from '@/lib/header-layout';
import {getValidSession} from '@/lib/supabase/client';
type Action={key:string;label:string};
export default function ApprovedDashboardMenus<T extends Action>({groups,onLaunch,userId,hotelId}:{groups:Array<{label:string;items:T[]}>;onLaunch:(action:T,clickedAt:number)=>void;userId:string;hotelId:string}){
 const root=useRef<HTMLDivElement>(null),latest=useRef(onLaunch);useEffect(()=>{latest.current=onLaunch},[onLaunch]);
 const [error,setError]=useState('');
 const signature=JSON.stringify(groups);
 useEffect(()=>{
  if(!root.current||!userId)return;
  const element=root.current,key=`cmpri:header-layout:${hotelId}:${userId}`;
  let active=true,dirty=false,sending=false,pending:HeaderLayout|null=null,unmount:(()=>void)|undefined;
  let layout=normalizeHeaderLayout(null);try{layout=normalizeHeaderLayout(JSON.parse(localStorage.getItem(key)||'{}'))}catch{}
  const headers=async()=>{const session=await getValidSession();if(session?.user.id!==userId)throw Error('Account changed.');return {Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'}};
  const persist=async()=>{if(sending)return;sending=true;try{while(pending){const next=pending;pending=null;try{const response=await fetch('/api/profile/header-layout',{method:'PUT',headers:await headers(),body:JSON.stringify({layout:next})});if(!response.ok)throw Error('Save failed.');if(active)setError('')}catch{pending??=next;if(active)setError('Your arrangement is saved on this device. Sync will retry when you return.');break}}}finally{sending=false}};
  const save=(value:HeaderLayout)=>{layout=normalizeHeaderLayout(value);dirty=true;try{localStorage.setItem(key,JSON.stringify(layout))}catch{}pending=layout;void persist()};
  const mount=()=>{unmount?.();unmount=mountApprovedMenus(element,JSON.parse(signature).map((g:{label:string;items:T[]})=>({...g,items:g.items.map(a=>({...a,style:headerActionStyle(a.label)}))})),(action:T,at:number)=>latest.current(action,at),layout,save)};
  const load=async()=>{if(document.hidden||sending)return;if(pending){void persist();return}try{const response=await fetch('/api/profile/header-layout',{headers:await headers(),cache:'no-store'});if(!response.ok)throw Error('Load failed.');const data=await response.json();if(!active||dirty)return;const next=normalizeHeaderLayout(data.layout);if(JSON.stringify(next)!==JSON.stringify(layout)){layout=next;mount()}try{localStorage.setItem(key,JSON.stringify(layout))}catch{}}catch{}};
  mount();void load();const wake=()=>{dirty=false;void load()};window.addEventListener('focus',wake);window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
  return()=>{active=false;unmount?.();window.removeEventListener('focus',wake);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake)};
 },[signature,userId,hotelId]);
 return <div className="min-w-0 w-full"><div ref={root} className="cmpri-header-v23"/>{error&&<p role="status" className="text-xs text-amber-200">{error}</p>}</div>;
}
