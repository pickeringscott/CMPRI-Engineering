"use client";
import {getValidSession,createClient} from '@/lib/supabase/client';
import {isNotesSessionRestart} from './general-notes-session';
import {GeneralNotesSync,NoteSyncError} from './general-notes-sync';
import {noteDocument,type NoteScope} from './general-notes';
export function createNotesSync(scope:NoteScope){
 const authorization=async()=>{const session=await getValidSession();if(!session||session.user.id!==scope.userId)throw new NoteSyncError('Sign in again to sync this account’s notes.',401);return {Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json','X-CMPRI-Property':scope.hotelId}};
 async function request(path:string,options:RequestInit={}){const init={...options,headers:await authorization(),cache:'no-store' as RequestCache};let response=await fetch(path,init);if(await isNotesSessionRestart(response))response=await fetch(path,init);if(await isNotesSessionRestart(response))throw new NoteSyncError('Session check restarted. Your local draft is safe.',503);const data=await response.json().catch(()=>({}));if(!response.ok)throw new NoteSyncError(data.error||'Could not sync. Changes are protected on this device.',response.status);return data}
 const storage={getItem:(key:string)=>localStorage.getItem(key),setItem:(key:string,value:string)=>localStorage.setItem(key,value),removeItem:(key:string)=>localStorage.removeItem(key)};
 return new GeneralNotesSync(scope,storage,{
  list:async()=>(await request('/api/notes')).notes,
  read:async id=>(await request('/api/notes?id='+encodeURIComponent(id))).note,
  write:async(pending,keepalive,deleted)=>(await request('/api/notes',{method:'PUT',keepalive:keepalive&&JSON.stringify(pending.note).length<50_000,body:JSON.stringify({id:pending.note.id,expectedRevision:pending.expectedRevision,changeId:pending.changeId,document:deleted?null:noteDocument(pending.note)})})).note,
 });
}
export function watchNotes(scope:NoteScope,sync:GeneralNotesSync){
 const client=createClient();
 const channel=client.channel('general-notes:'+scope.hotelId+':'+scope.userId+':'+crypto.randomUUID()).on('postgres_changes',{event:'*',schema:'public',table:'cmpri_general_notes',filter:'user_id=eq.'+scope.userId},payload=>{const row=payload.new as {hotel_id?:string;change_id?:string};if(row.hotel_id===scope.hotelId&&!sync.ownChanges.has(row.change_id||'')&&!document.hidden)void sync.refresh(true)}).subscribe(status=>{if(status==='SUBSCRIBED'&&!document.hidden)void sync.refresh()});
 const wake=()=>{if(!document.hidden){void sync.refresh();void sync.flushAll()}};
 window.addEventListener('focus',wake);window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
 return()=>{void client.removeChannel(channel);window.removeEventListener('focus',wake);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake)};
}
