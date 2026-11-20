"use client";
import {useEffect,useRef,useState} from 'react';
import {mountApprovedMenus} from '@/lib/ui/approved-header-menus';
import {mountAnchoredMenus} from '@/lib/ui/anchored-dashboard-menus';
import {modalLauncherStyle} from '@/lib/ui/header-palette';
import {allowsAnchoredHeaderPlacement,anchoredHeaderLayoutForGroups,normalizeHeaderLayout,headerLayoutForGroups,type AnchoredMenuRestriction,type HeaderLayout} from '@/lib/header-layout';
import {useStaffNotesSummary} from '@/lib/staff-notes-unread';
import {getValidSession} from '@/lib/supabase/client';
type Action={key:string;label:string};
type MenuGroup<T>={label:string;items:T[];centered?:boolean};
type MenuProps<T>={
 groups:MenuGroup<T>[];
 onLaunch:(action:T,clickedAt:number)=>void;
 userId:string;
 hotelId:string;
 anchored?:boolean;
 restriction?:AnchoredMenuRestriction;
};

function readCachedLayout(key: string): HeaderLayout | null {
 try {
  const value = localStorage.getItem(key);
  return value ? normalizeHeaderLayout(JSON.parse(value)) : null;
 } catch {
  return null;
 }
}

export default function ApprovedDashboardMenus<T extends Action>({groups,onLaunch,userId,hotelId,anchored=false,restriction=null}:MenuProps<T>){
 const root=useRef<HTMLDivElement>(null),latest=useRef(onLaunch);useEffect(()=>{latest.current=onLaunch},[onLaunch]);
 const writes=useRef<Promise<unknown>>(Promise.resolve());
 const [error,setError]=useState('');
 const summary=useStaffNotesSummary();
 const notebookGroups=anchored?groups:groups.map(group=>({...group,items:group.items.flatMap(action=>action.key==='/staff-notes'&&!group.items.some(item=>item.key==='/notes')?[action,{...action,key:'/notes',href:'/notes',label:'Notes'}]:[action])}));
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
  const pendingKey=`${key}:pending`;
  let active=true,sending=false,loading=false,revision=0,unmount:(()=>void)|undefined;
  let pending=readCachedLayout(pendingKey);
  let layout=pending ?? readCachedLayout(key) ?? normalizeHeaderLayout(null);
  const headers=async()=>{const session=await getValidSession();if(session?.user.id!==userId)throw Error('Account changed.');return {Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'}};
  const persist=async()=>{
   if(sending)return;
   sending=true;
   try{
    while(active&&pending){
     const next=pending;
     const serialized=JSON.stringify(next);
     pending=null;
     const write=writes.current.catch(()=>{}).then(async()=>{
      if(!active)return false;
      const response=await fetch('/api/profile/header-layout',{method:'PUT',headers:await headers(),body:JSON.stringify({layout:next})});
      if(!response.ok)throw Error('Save failed.');
      try{
       if(localStorage.getItem(pendingKey)===serialized)localStorage.removeItem(pendingKey);
      }catch{}
      return true;
     });
     writes.current=write;
     try{
      if(!await write)break;
      if(active)setError('');
     }catch{
      pending??=next;
      if(active)setError('Layout sync failed. CMPRI will retry when you return.');
      break;
     }
    }
   }finally{sending=false}
  };
  const save=(value:HeaderLayout)=>{
   layout=normalizeHeaderLayout(value);
   revision++;
   pending=layout;
   try{
    const serialized=JSON.stringify(layout);
    localStorage.setItem(pendingKey,serialized);
    localStorage.setItem(key,serialized);
   }catch{}
   void persist();
  };
  const styledGroups=(JSON.parse(signature) as MenuGroup<T>[]).map(group=>({
   ...group,items:group.items.map(action=>({...action,style:modalLauncherStyle(action.key,action.label)})),
  }));
  const launch=(action:T,at:number)=>latest.current(action,at);
  const mount=()=>{
   unmount?.();
   if(!anchored){
    unmount=mountApprovedMenus(element,styledGroups,launch,headerLayoutForGroups(layout,styledGroups.map(group=>group.label)),save);
    return;
   }
   const projection=anchoredHeaderLayoutForGroups(layout,styledGroups,restriction);
   unmount=mountAnchoredMenus(element,projection.groups,launch,projection.layout,save,{
    canDrop:(key,label)=>allowsAnchoredHeaderPlacement(restriction,key,label),
   });
  };
  const load=async()=>{
   if(document.hidden||sending||loading)return;
   if(pending){void persist();return}
   const requestedAt=revision;
   loading=true;
   try{
    const response=await fetch('/api/profile/header-layout',{headers:await headers(),cache:'no-store'});
    if(!response.ok)throw Error('Load failed.');
    const data=await response.json();
    if(!active||revision!==requestedAt)return;
    const next=normalizeHeaderLayout(data.layout);
    if(JSON.stringify(next)!==JSON.stringify(layout)){layout=next;mount()}
    try{localStorage.setItem(key,JSON.stringify(layout))}catch{}
   }catch{}finally{loading=false}
  };
  mount();void load();const wake=()=>void load();window.addEventListener('focus',wake);window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
  return()=>{active=false;unmount?.();window.removeEventListener('focus',wake);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake)};
 },[signature,userId,hotelId,anchored,restriction]);
 return <div className={anchored?"cmpri-dashboard-menu-overlay min-w-0 w-full":"min-w-0 w-full"}><div ref={root} className={anchored?"cmpri-header-v23 anchored-menu":"cmpri-header-v23"}/>{error&&<p role="status" className="text-xs text-amber-200">{error}</p>}</div>;
}
