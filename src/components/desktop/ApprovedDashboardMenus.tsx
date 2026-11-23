"use client";
import {useUiLanguage} from "@/components/UiLanguageProvider";
import {useEffect,useRef,useState} from 'react';
import {mountApprovedMenus} from '@/lib/ui/approved-header-menus';
import {mountAnchoredMenus} from '@/lib/ui/anchored-dashboard-menus';
import {mountAskDashboardLauncher} from '@/lib/ui/ask-dashboard-launcher';
import {modalLauncherStyle} from '@/lib/ui/header-palette';
import {allowsAnchoredHeaderPlacement,anchoredHeaderLayoutForGroups,normalizeHeaderLayout,headerLayoutForGroups,type AnchoredMenuRestriction,type HeaderLayout} from '@/lib/header-layout';
import {useStaffNotesSummary} from '@/lib/staff-notes-unread';
import {getValidSession} from '@/lib/supabase/client';
import {subscribeResources} from '@/lib/events/browser';
import '@/app/ask-dashboard-launcher.css';
type Action={key:string;label:string};
type MenuGroup<T>={label:string;items:T[];centered?:boolean};
type MenuProps<T>={
 groups:MenuGroup<T>[];
 onLaunch:(action:T,clickedAt:number,opener?:HTMLButtonElement)=>void;
 userId:string;
 hotelId:string;
 anchored?:boolean;
 askEnabled?:boolean;
 restriction?:AnchoredMenuRestriction;
};
type AskLauncherState = ReturnType<NonNullable<ReturnType<typeof mountAskDashboardLauncher>>["getState"]>;

function readCachedLayout(key: string): HeaderLayout | null {
 try {
  const value = localStorage.getItem(key);
  return value ? normalizeHeaderLayout(JSON.parse(value)) : null;
 } catch {
  return null;
 }
}

export default function ApprovedDashboardMenus<T extends Action>({groups,onLaunch,userId,hotelId,anchored=false,askEnabled=false,restriction=null}:MenuProps<T>){
 const { t, tt }=useUiLanguage();
 const presentation=useRef({t,tt});
 const localize=useRef<((value:{t:typeof t;tt:typeof tt})=>void)|null>(null);
 useEffect(()=>{presentation.current={t,tt};localize.current?.({t,tt})},[t,tt]);
 const root=useRef<HTMLDivElement>(null),latest=useRef(onLaunch);useEffect(()=>{latest.current=onLaunch},[onLaunch]);
 const writes=useRef<Promise<unknown>>(Promise.resolve());
 const savedAskState=useRef<{scope:string;state:AskLauncherState}|null>(null);
 const [error,setError]=useState('');
 const summary=useStaffNotesSummary();
 const notebookGroups=anchored?groups:groups.map(group=>({...group,items:group.items.flatMap(action=>action.key==='/staff-notes'&&!group.items.some(item=>item.key==='/notes')?[action,{...action,key:'/notes',href:'/notes',label:'Notes'}]:[action])}));
 const signature=JSON.stringify(notebookGroups);
 useEffect(()=>{
  const element=root.current;if(!element)return;
  const count=summary?.hotelId===hotelId&&summary?.userId===userId?summary.flagCount:0;
  const apply=()=>{for(const button of element.querySelectorAll<HTMLButtonElement>('[data-key="/staff-notes"]')){
   button.dataset.staffNotesBaseTitle??=button.title;
   if(count){button.dataset.staffNotesUnread=String(count);button.setAttribute('aria-description',t('{count} new Staff Notes',{count}));button.title=button.dataset.staffNotesBaseTitle+' · '+tt('{count} new Staff Notes',{count})}
   else{delete button.dataset.staffNotesUnread;button.removeAttribute('aria-description');button.title=button.dataset.staffNotesBaseTitle}
  }};
  apply();const observer=new MutationObserver(apply);observer.observe(element,{childList:true,subtree:true});return()=>observer.disconnect();
 },[summary,userId,hotelId,signature,t,tt]);
 useEffect(()=>{
  if(!root.current||!userId)return;
  const element=root.current,key=`cmpri:header-layout:${hotelId}:${userId}`;
  const askScope=`${hotelId}:${userId}`;
  const pendingKey=`${key}:pending`;
  let active=true,sending=false,loading=false,refreshPending=false,revision=0,unmount:ReturnType<typeof mountApprovedMenus>|ReturnType<typeof mountAnchoredMenus>|undefined;
  let askLauncher:ReturnType<typeof mountAskDashboardLauncher>;
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
   }finally{sending=false;if(active&&refreshPending&&!pending)void load()}
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
  const launch=(action:T,at:number,opener?:HTMLButtonElement)=>{
   if(askEnabled&&action.key==='/staff-notes'){
    window.dispatchEvent(new CustomEvent('cmpri-ask-open',{detail:{tab:'staff',opener}}));
    return;
   }
   latest.current(action,at,opener);
  };
  const mount=()=>{
   const askState=askLauncher?.getState() ?? (savedAskState.current?.scope===askScope ? savedAskState.current.state : undefined);
   askLauncher?.dispose();
   unmount?.();
   if(!anchored){
    unmount=mountApprovedMenus(element,styledGroups,launch,headerLayoutForGroups(layout,styledGroups.map(group=>group.label)),save,presentation.current);
    localize.current=unmount.setPresentation;
    return;
   }
   const projection=anchoredHeaderLayoutForGroups(layout,styledGroups,restriction);
   unmount=mountAnchoredMenus(element,projection.groups,launch,projection.layout,save,{
    canDrop:(key,label)=>allowsAnchoredHeaderPlacement(restriction,key,label),
    ...presentation.current,
   });
   askLauncher=askEnabled ? mountAskDashboardLauncher(element,askScope,presentation.current.t,askState) : undefined;
   localize.current=next=>{
    unmount?.setPresentation(next);
    askLauncher?.setPresentation(next.t);
   };
  };
  const load=async()=>{
   if(!active||document.hidden||sending||loading||document.body.classList.contains('drag-active'))return;
   if(pending){void persist();return}
   refreshPending=false;
   const requestedAt=revision;
   loading=true;
   try{
    const response=await fetch('/api/profile/header-layout',{headers:await headers(),cache:'no-store'});
    if(!response.ok)throw Error('Load failed.');
    const data=await response.json();
    if(!active||revision!==requestedAt)return;
    if(document.body.classList.contains('drag-active')){refreshPending=true;return}
    const next=normalizeHeaderLayout(data.layout);
    if(JSON.stringify(next)!==JSON.stringify(layout)){layout=next;mount()}
    try{localStorage.setItem(key,JSON.stringify(layout))}catch{}
   }catch{}finally{loading=false;if(active&&refreshPending&&!pending)void load()}
  };
  const stopResources=subscribeResources(['session'],async()=>{refreshPending=true;await load()},false);
  const gestures=new MutationObserver(()=>{if(refreshPending&&!document.body.classList.contains('drag-active'))void load()});
  gestures.observe(document.body,{attributes:true,attributeFilter:['class']});
  mount();void load();const wake=()=>void load();window.addEventListener('focus',wake);window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
  return()=>{
   active=false;localize.current=null;stopResources();gestures.disconnect();
   if(askLauncher){savedAskState.current={scope:askScope,state:askLauncher.getState()};askLauncher.dispose()}
   unmount?.();window.removeEventListener('focus',wake);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake);
  };
 },[signature,userId,hotelId,anchored,askEnabled,restriction]);
 return <div className={anchored?"cmpri-dashboard-menu-overlay min-w-0 w-full":"min-w-0 w-full"}><div ref={root} className={anchored?"cmpri-header-v23 anchored-menu":"cmpri-header-v23"}/>{error&&<p role="status" className="text-xs text-amber-200">{t(error)}</p>}</div>;
}
