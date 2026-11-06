"use client";
import {useEffect,useRef,useState} from 'react';
import WorkOrderMediaControl from './WorkOrderMediaControl';
import {getValidSession} from '@/lib/supabase/client';
import {uploadWorkOrderAttachment} from '@/lib/work-order-attachment-upload';
type Pending={file:File;url:string;id:string};
export default function WorkOrderMediaComposer({workOrderId,disabled,hasNote,onSubmitNote,onUploaded,onPendingChange,onBusyChange}:{workOrderId:string;disabled:boolean;hasNote:boolean;onSubmitNote:()=>Promise<boolean|undefined>;onUploaded:()=>Promise<unknown>;onPendingChange:(pending:boolean)=>void;onBusyChange:(busy:boolean)=>void}){
 const [files,setFiles]=useState<Pending[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');const pending=useRef<Pending[]>([]),active=useRef(true),inFlight=useRef(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;for(const item of pending.current)URL.revokeObjectURL(item.url)}},[]);
 function replace(next:Pending[]){pending.current=next;if(active.current){setFiles(next);onPendingChange(!!next.length)}}
 function remove(id:string){const item=pending.current.find(item=>item.id===id);if(item)URL.revokeObjectURL(item.url);replace(pending.current.filter(item=>item.id!==id))}
 async function submit(){if(inFlight.current||disabled)return;inFlight.current=true;setBusy(true);onBusyChange(true);setError('');try{
  if(pending.current.length){const session=await getValidSession();if(!session?.access_token)throw Error('Sign in again before uploading attachments.');
   for(const item of [...pending.current]){if(!active.current)return;const result=await uploadWorkOrderAttachment(workOrderId,item.file,session.access_token,item.id);if(!result.ok)throw Error(result.message);remove(item.id)}
   if(active.current)await onUploaded();
  }
  if(active.current&&hasNote)await onSubmitNote();
 }catch(e){if(active.current){setError(e instanceof Error?e.message:'Attachments could not be saved. Your remaining selections are retained.');await onUploaded()}}
 finally{inFlight.current=false;if(active.current){setBusy(false);onBusyChange(false)}}}
 return <><div className="preview-note-actions"><div className="preview-note-thumbnails">{[...files].reverse().map(item=><span className="preview-note-thumbnail" key={item.id}>{item.file.type.startsWith('video/')?<video src={item.url} muted preload="metadata"/>:<img src={item.url} alt={item.file.name}/>}<button type="button" disabled={busy||disabled} onClick={()=>remove(item.id)} aria-label={'Remove '+item.file.name}>×</button></span>)}</div><WorkOrderMediaControl disabled={busy||disabled} onSelect={chosen=>replace([...pending.current,...chosen.map(file=>({file,id:crypto.randomUUID(),url:URL.createObjectURL(file)}))])}/><button type="button" onClick={()=>void submit()} disabled={busy||disabled||(!hasNote&&!files.length)} className="rounded-lg bg-sky-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40">{busy?'Saving…':'Submit Note'}</button></div>{error&&<p role="alert" className="text-xs text-red-200">{error}</p>}</>;
}
