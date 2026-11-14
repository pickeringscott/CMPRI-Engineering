"use client";
import {useEffect,useRef,useState} from 'react';
import {mountApprovedMenus} from '@/lib/ui/approved-header-menus';
import {modalLauncherStyle} from '@/lib/ui/header-palette';
import {normalizeHeaderLayout,headerLayoutForGroups,type HeaderLayout} from '@/lib/header-layout';
import {useStaffNotesSummary} from '@/lib/staff-notes-unread';
import {getValidSession} from '@/lib/supabase/client';
type Action={key:string;label:string};
export default function ApprovedDashboardMenus<T extends Action>({groups,onLaunch,userId,hotelId}:{groups:Array<{label:string;items:T[]}>;onLaunch:(action:T,clickedAt:number)=>void;userId:string;hotelId:string}){
 const root=useRef<HTMLDivElement>(null),latest=useRef(onLaunch);useEffect(()=>{latest.current=onLaunch},[onLaunch]);
 const [error,setError]=useState('');
 const summary=useStaffNotesSummary();
 const notebookGroups=groups.map(group=>({...group,items:group.items.flatMap(action=>action.key==='/staff-notes'&&!group.items.some(item=>item.key==='/notes')?[action,{...action,key:'/notes',href:'/notes',label:'Notes'}]:[action])}));
 const notebookAction=notebookGroups.flatMap(group=>group.items).find(action=>action.key==='/notes');
 const signature=JSON.stringify(notebookGroups);
 useEffect(()=>{
  const element=root.current;if(!element)return;
  const count=summary?.hotelId===hotelId&&summary?.userId===userId?summary.flagCount:0;
  const apply=()=>{for(const button of element.querySelectorAll<HTMLButtonElement>('[data-key="/staff-notes"]')){
   button.dataset.staffNotesBaseTitle??=button.title;
   if(count){button.dataset.staffNotesUnread=String(count);button.setAttribute('aria-description',`${count} new Staff Notes`);button.title=button.dataset.staffNotesBaseTitle+` · ${count} new Staff Notes`}
   else{delete button.dataset.staffNotesUnread;button.removeAttribute('aria-description');button.title=button.dataset.staffNotesBaseTitle}
  }};
  apply();const observer=new MutationObserver(apply);observer.observe(element,{childList:true,subtree:true});return()=>observer.disconnect();
 },[summary,userId,hotelId,signature]);
 useEffect(()=>{
  if(!root.current||!userId)return;
  const element=root.current,key=`cmpri:header-layout:${hotelId}:${userId}`;
  let active=true,dirty=false,sending=false,pending:HeaderLayout|null=null,unmount:(()=>void)|undefined;
  let layout=normalizeHeaderLayout(null);try{layout=normalizeHeaderLayout(JSON.parse(localStorage.getItem(key)||'{}'))}catch{}
  const headers=async()=>{const session=await getValidSession();if(session?.user.id!==userId)throw Error('Account changed.');return {Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'}};
  const persist=async()=>{if(sending)return;sending=true;try{while(pending){const next=pending;pending=null;try{const response=await fetch('/api/profile/header-layout',{method:'PUT',headers:await headers(),body:JSON.stringify({layout:next})});if(!response.ok)throw Error('Save failed.');if(active)setError('')}catch{pending??=next;if(active)setError('Your arrangement is saved on this device. Sync will retry when you return.');break}}}finally{sending=false}};
  const save=(value:HeaderLayout)=>{layout=normalizeHeaderLayout(value);dirty=true;try{localStorage.setItem(key,JSON.stringify(layout))}catch{}pending=layout;void persist()};
  const mount=()=>{unmount?.();unmount=mountApprovedMenus(element,JSON.parse(signature).map((g:{label:string;items:T[]})=>({...g,items:g.items.map(a=>({...a,style:modalLauncherStyle(a.key,a.label)}))})),(action:T,at:number)=>latest.current(action,at),headerLayoutForGroups(layout,JSON.parse(signature).map((g:{label:string})=>g.label)),save)};
  const load=async()=>{if(document.hidden||sending)return;if(pending){void persist();return}try{const response=await fetch('/api/profile/header-layout',{headers:await headers(),cache:'no-store'});if(!response.ok)throw Error('Load failed.');const data=await response.json();if(!active||dirty)return;const next=normalizeHeaderLayout(data.layout);if(JSON.stringify(next)!==JSON.stringify(layout)){layout=next;mount()}try{localStorage.setItem(key,JSON.stringify(layout))}catch{}}catch{}};
  mount();void load();const wake=()=>{dirty=false;void load()};window.addEventListener('focus',wake);window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
  return()=>{active=false;unmount?.();window.removeEventListener('focus',wake);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake)};
 },[signature,userId,hotelId]);
 return <div className="min-w-0 w-full">{notebookAction&&<button type="button" className="mb-1 rounded border px-2 py-0.5 text-xs lg:hidden" style={modalLauncherStyle('/notes','Notes')} onClick={()=>onLaunch(notebookAction,Date.now())}>Notes</button>}<div ref={root} className="cmpri-header-v23"/>{error&&<p role="status" className="text-xs text-amber-200">{error}</p>}</div>;
}
