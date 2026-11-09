"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {getValidSession} from '@/lib/supabase/client';
import type {InventoryResult} from '@/lib/inventory';
type Pending={method:'POST'|'PATCH';body:Record<string,unknown>};
export default function useInventoryCommands(scope:string,onResult:(result:InventoryResult)=>void){
 const [busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[hydrated,setHydrated]=useState(false);
 const pending=useRef<Pending|null>(null),inFlight=useRef(false),epoch=useRef(0);
 const key=`cmpri:inventory-save:v1:${scope}`;
 useEffect(()=>{
  const generation=++epoch.current;pending.current=null;
  void Promise.resolve().then(()=>{
   if(generation!==epoch.current||!scope)return;
   setHydrated(false);setUncertain(false);setError('');
   try{const value=localStorage.getItem(key);if(value){const parsed=JSON.parse(value);if(['POST','PATCH'].includes(parsed.method)&&typeof parsed.body?.request_id==='string'&&['inventory','idea'].includes(parsed.body.kind)){pending.current=parsed;setUncertain(true);setError('An inventory save is unconfirmed. Retry it to confirm the same operation safely.');}}}catch{setError('The saved inventory operation could not be read. Review the item before retrying.');}
   setHydrated(true);
  });
  return()=>{epoch.current=generation+1;};
 },[key,scope]);
 const send=useCallback(async(operation:Pending,preserved=false):Promise<InventoryResult|null>=>{
  if(inFlight.current||!scope)return null;
  try{if(!preserved)localStorage.setItem(key,JSON.stringify(operation));}catch{setError('Device storage could not preserve this save. Free storage before changing inventory.');return null;}
  const generation=epoch.current;inFlight.current=true;setBusy(true);setError('');
  try{
   const session=await getValidSession();
   if(!session||!scope.endsWith(`:${session.user.id}`))throw Error('The device account changed. Reopen Inventory before continuing.');
   const response=await fetch('/api/engineering/catalog',{method:operation.method,headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(operation.body)});
   const data=await response.json().catch(()=>null);
   if(generation!==epoch.current)return null;
   if(!response.ok){
    if(response.status<500&&![408,429].includes(response.status)){pending.current=null;try{localStorage.removeItem(key);}catch{}setUncertain(false);}
    throw Error(data?.error||'Inventory save was not confirmed.');
   }
   if(!data||(!data.inventory_item&&!data.idea))throw Error('Inventory save could not be confirmed. Retry the same save.');
   onResult(data);pending.current=null;setUncertain(false);try{localStorage.removeItem(key);}catch{/* A replay remains safe if clearing storage fails. */}return data;
  }catch(error){if(generation===epoch.current){if(pending.current)setUncertain(true);setError(error instanceof Error?error.message:'Inventory save was not confirmed.');}return null;}
  finally{inFlight.current=false;if(generation===epoch.current)setBusy(false);}
 },[key,scope,onResult]);
 const command=useCallback(async(method:'POST'|'PATCH',body:Record<string,unknown>):Promise<InventoryResult|null>=>{
  if(!hydrated||!scope||inFlight.current)return null;
  if(pending.current){setError('Retry the unconfirmed save before starting another inventory operation.');return null;}
  const operation={method,body:{...body,request_id:crypto.randomUUID()}};
  try{localStorage.setItem(key,JSON.stringify(operation));}catch{setError('Device storage could not preserve this save. Free storage before changing inventory.');return null;}
  pending.current=operation;return send(operation,true);
 },[key,scope,hydrated,send]);
 const retry=useCallback(()=>pending.current?send(pending.current):Promise.resolve(null),[send]);
 useEffect(()=>{const cancel=(event:Event)=>{if(uncertain||inFlight.current)event.preventDefault();};document.addEventListener('cmpri-modal-cancel-request',cancel);return()=>document.removeEventListener('cmpri-modal-cancel-request',cancel);},[uncertain]);
 useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(uncertain||inFlight.current){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[uncertain]);
 return {command,retry,busy,uncertain,error,hydrated,clearError:()=>setError('')};
}
export type InventoryCommands=ReturnType<typeof useInventoryCommands>;
