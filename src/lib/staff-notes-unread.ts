"use client";
import {useSyncExternalStore} from 'react';
import type {StaffFlagWindow} from './staff-note-flags';
export type StaffNotesSummary={unread:number;unreadKeys:string[];frontDesk:boolean;management:boolean;alertNow:boolean;hotelId:string;userId:string;flagCount:number;flagWindows:StaffFlagWindow[];nextFlagChangeAt:string|null};
let value:StaffNotesSummary|null=null;
const listeners=new Set<()=>void>();
export function publishStaffNotesSummary(next:StaffNotesSummary|null){value=next;for(const listener of listeners)listener()}
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}};
export function useStaffNotesSummary(){return useSyncExternalStore(subscribe,()=>value,()=>null)}
export function expireStaffNotesFlag(summary:StaffNotesSummary,now=Date.now()):StaffNotesSummary{
  if(!summary.frontDesk)return summary;
  const flagWindows=(summary.flagWindows||[]).filter(w=>Date.parse(w.expiresAt)>now);
  return {...summary,flagWindows,flagCount:flagWindows.reduce((sum,w)=>sum+w.count,0),nextFlagChangeAt:flagWindows[0]?.expiresAt||null};
}
