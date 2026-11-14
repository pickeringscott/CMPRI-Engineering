"use client";
import {useEffect,useId,useState,type KeyboardEvent,type RefObject} from 'react';
import {authorizationHeaders} from '@/lib/auth/client-session';
import {staffMentionQuery,staffReferenceQuery,staffMentionSuggestions,staffTargetKey,staffTargetType,insertStaffMention,insertStaffReference,type StaffMention,type StaffMentionRange} from '@/lib/staff-note-targets';
import {staffMentionMatches} from '@/lib/staff-notes';
import {workOrderReferences,workOrderNumber} from '@/lib/work-order-reference.js';
import {plainTextParts} from '@/lib/plain-text-links';
export type NoteToken={start:number;end:number;href?:string;external?:boolean;kind?:string};
type Ticket={id:string;display_id:string;room?:string;issue?:string};
export function useGeneralNotesMentions({text,caret,selected,active,field,onEdit}:{text:string;caret:number;selected:StaffMentionRange[];active:boolean;field:RefObject<HTMLTextAreaElement|null>;onEdit:(text:string,mentions:StaffMentionRange[],caret:number)=>void}){
 const id=useId(),[directory,setDirectory]=useState<StaffMention[]|null>(null),[tickets,setTickets]=useState<Ticket[]>([]),[index,setIndex]=useState(0),[dismissed,setDismissed]=useState(''),[error,setError]=useState('');
 const raw=active?staffMentionQuery(text,caret):null;
 const query=raw&&!selected.some(m=>m.start===raw.start&&caret>=m.end)?raw:null;
 const reference=active?staffReferenceQuery(text,caret):null;
 const lookup=(query?.query.match(/^(?:WO\s*[#-]?\s*|work\s+order\s*#?\s*|#)?(\d+)$/i)||[])[1]||reference?.number||'';
 const wantsDirectory=!!raw||selected.length>0;
 useEffect(()=>{if(!wantsDirectory||directory)return;const abort=new AbortController();void(async()=>{try{const response=await fetch('/api/notes/targets',{headers:await authorizationHeaders(),signal:abort.signal,cache:'no-store'});if(!response.ok)throw Error('Mention targets could not be loaded. Type @ again to retry.');const data=await response.json();if(!abort.signal.aborted){setDirectory(data.mentions||[]);setError('')}}catch(error){if(!abort.signal.aborted)setError(error instanceof Error?error.message:'Mentions unavailable.')}})();return()=>abort.abort()},[wantsDirectory,directory]);
 const references=workOrderReferences(text).filter(r=>!plainTextParts(text).some(p=>p.href&&p.start<r.end&&p.end>r.start));
 const targets=JSON.stringify([...new Set([...references.map(r=>'number:'+r.number),...selected.filter(m=>m.kind==='work_order').map(m=>'id:'+m.id.replaceAll('-','')),...(lookup?['number:'+lookup]:[])])].sort().slice(0,100));
 useEffect(()=>{const values=JSON.parse(targets) as string[];if(!values.length)return;const abort=new AbortController();const timer=setTimeout(()=>{void(async()=>{try{const response=await fetch('/api/work-orders/references?'+values.map(value=>'target='+encodeURIComponent(value)).join('&'),{headers:await authorizationHeaders(),signal:abort.signal,cache:'no-store'});if(!response.ok){if(!abort.signal.aborted)setTickets([]);return}const data=await response.json();if(!abort.signal.aborted)setTickets(data.tickets||[])}catch{if(!abort.signal.aborted)setTickets([])}})()},120);return()=>{clearTimeout(timer);abort.abort()}},[targets]);
 const candidates=query?staffMentionSuggestions(query.query,directory||[]):[];
 const ticketChoices:StaffMention[]=lookup?tickets.filter(t=>workOrderNumber(t.display_id)===lookup).map(t=>({id:t.id,kind:'work_order',label:'WO#'+lookup,description:[t.room,t.issue].filter(Boolean).join(' · '),userIds:[]})):[];
 const signature=text+'\u0000'+caret,options=active&&dismissed!==signature?[...candidates,...ticketChoices].slice(0,30):[],current=index%Math.max(1,options.length);
 function accept(target:StaffMention){const range=target.kind==='work_order'&&reference?reference:query;if(!range)return;const inserted=target.kind==='work_order'&&reference?insertStaffReference(text,range,target,selected):insertStaffMention(text,range,target,selected);onEdit(inserted.value,inserted.mentions,inserted.caret);setDismissed(inserted.value+'\u0000'+inserted.caret);if(field.current){field.current.value=inserted.value;field.current.focus({preventScroll:true});field.current.setSelectionRange(inserted.caret,inserted.caret)}}
 function keyDown(event:KeyboardEvent<HTMLTextAreaElement>){if(!active||event.nativeEvent.isComposing||!options.length)return false;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setDismissed(signature);return true}if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();setIndex((current+(event.key==='ArrowDown'?1:-1)+options.length)%options.length);return true}if(event.key==='Tab'||(event.key==='Enter'&&!event.shiftKey)){event.preventDefault();accept(options[current]);return true}return false}
 const urls=plainTextParts(text).filter(p=>p.href);
 const mentions=[...selected,...staffMentionMatches(text,directory||[]).filter(m=>!selected.some(s=>s.start<m.end&&s.end>m.start)).map(m=>({...m,...m.mention}))];
 const tokens:NoteToken[]=[...urls.map(p=>({...p,external:true})),...mentions.filter(m=>!urls.some(p=>p.start<m.end&&p.end>m.start)).map(m=>({start:m.start,end:m.end,kind:m.kind,...(m.kind==='work_order'&&tickets.some(t=>t.id===m.id)?{href:'/work-orders/'+encodeURIComponent(m.id)}:{})}))];
 for(const ref of references){if(tokens.some(t=>t.start<ref.end&&t.end>ref.start))continue;const matches=tickets.filter(t=>workOrderNumber(t.display_id)===ref.number);tokens.push({...ref,kind:'work_order',...(matches.length===1?{href:'/work-orders/'+encodeURIComponent(matches[0].id)}:{})})}
 tokens.sort((a,b)=>a.start-b.start);
 const popup=<>{options.length>0&&<div id={id} className="general-notes-mention-options" role="listbox" aria-label="Mention targets">{options.map((target,i)=><button key={staffTargetKey(target)} id={id+'-'+i} type="button" role="option" aria-selected={i===current} tabIndex={-1} onPointerDown={event=>event.preventDefault()} onClick={()=>accept(target)}><span>{target.label}{target.description?' · '+target.description:''}</span><small>{staffTargetType(target.kind)}</small></button>)}</div>}{error&&active&&raw&&<p className="general-notes-mention-error" role="status">{error}</p>}</>;
 return{keyDown,tokens,popup,controls:options.length?id:undefined,activeDescendant:options.length?id+'-'+current:undefined};
}
