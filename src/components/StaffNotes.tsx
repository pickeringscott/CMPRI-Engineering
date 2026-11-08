"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useId, type FormEvent } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { createClient } from "@/lib/supabase/client";
import StaffNotesMedia,{StaffNoteAttachments} from './StaffNotesMedia';
import {STAFF_FILE_LIMIT,STAFF_ATTACHMENT_LIMIT,type StaffAttachment} from '@/lib/staff-note-media';
import {uploadStaffNoteFile} from '@/lib/staff-note-upload';
import {requestGiphy,type GiphyGif} from '@/lib/giphy';
import { staffMentionMatches, staffMentionCompletion, staffTicketReferences, staffAuthorMention, type StaffMention } from "@/lib/staff-notes";

import {staffMentionQuery,staffMentionSuggestions,staffTargetKey,staffTargetType,rebaseStaffMentions,insertStaffMention,insertStaffReference,selectedStaffMentions,staffReferenceQuery,type StaffMentionRange} from '@/lib/staff-note-targets';
import {workOrderNumber} from '@/lib/work-order-reference.js';
import {subscribeResources} from '@/lib/events/browser';
import { invalidateCachedResources } from '@/lib/data-cache/browser';
import {resourceViewVisible,watchResourceVisibility} from '@/lib/events/visibility';

type Note = { author_user_id?:string;author_name_id?:string|null;mentions?:StaffMentionRange[];id: string; author_name: string; body: string; parent_id: string | null; created_at: string; attachments?:StaffAttachment[]; gif_ids?:string[] };
type Payload = { notes: Note[]; parents: Note[]; mentions: StaffMention[]; management: boolean; frontDesk: boolean; hotelId: string; userId?:string;
  targets?:Record<string,{href:string;preview:string}>;tickets: Record<string, { href: string; preview: string }>; next: string | null };
export default function StaffNotes({ compact: forcedCompact }: { compact?: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const compact = forcedCompact === true;
  const [body, setBody] = useState("");
  const [selected,setSelected]=useState<StaffMentionRange[]>([]),[ticketChoices,setTicketChoices]=useState<{number:string;targets:StaffMention[]}>({number:'',targets:[]});
  const [activeSuggestion,setActiveSuggestion]=useState(0),[dismissed,setDismissed]=useState(false);
  const suggestionsId=useId();
  const [staffNameId,setStaffNameId]=useState('');
  const [staffName,setStaffName]=useState(''),[nameDraft,setNameDraft]=useState('');
  const [files,setFiles]=useState<Array<StaffAttachment & {file:File;uploaded:boolean}>>([]),[gifIds,setGifIds]=useState<string[]>([]),[gifs,setGifs]=useState<Record<string,GiphyGif>>({});
  const nameMode=Boolean(data?.frontDesk&&(!staffName||!staffNameId));
  const ownedURLs=useRef(new Set<string>()),accountKey=useRef('');
  useEffect(()=>{const urls=ownedURLs.current;return()=>{for(const url of urls)URL.revokeObjectURL(url)}},[]);
  const [reply, setReply] = useState<Note | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [caret, setCaret] = useState(0);
  const [connection, setConnection] = useState("Connecting…");
  const list = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), nameInput=useRef<HTMLInputElement>(null);
  const inFlight = useRef(false), request = useRef<{ id: string; fingerprint:string } | null>(null);
  const nearBottom = useRef(true),loadSequence=useRef(0);
  const mirror = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  const syncMirror = useCallback(() => {
    if (input.current && mirror.current) {
      const typography = window.getComputedStyle(input.current);
      for (const property of ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "word-spacing", "padding", "text-indent", "tab-size", "overflow-wrap", "word-break"]) {
        mirror.current.style.setProperty(property, typography.getPropertyValue(property), "important");
      }
      mirror.current.style.width = `${input.current.clientWidth}px`;
      mirror.current.style.transform = `translate(${-input.current.scrollLeft}px, ${-input.current.scrollTop}px)`;
    }
  }, []);
  const restoreGIFs=useCallback(async(ids:string[])=>{
    if(!ids.length)return;
    try{for(let i=0;i<ids.length;i+=50){const result=await requestGiphy('',{ids:ids.slice(i,i+50).join(',')});setGifs(old=>({...old,...Object.fromEntries(result.gifs.map(g=>[g.id,g]))}))}}catch{ /* Text and local files remain usable if the provider is unavailable. */ }
  },[]);
  const load = useCallback(async (before?: string) => {
    const sequence=++loadSequence.current;
    try {
      const response = await fetch(`/api/staff-notes${before ? `?before=${encodeURIComponent(before)}` : ""}`, { headers: await authorizationHeaders(), cache: "no-store" });
      const value = await response.json();
      if(sequence!==loadSequence.current)return;
      if (!response.ok) { if (response.status === 401 || response.status === 403) setData(null); throw new Error(value.error); }
      const owner=value.hotelId+':'+value.userId+':'+value.frontDesk;
      if(owner!==accountKey.current){
        if(accountKey.current){setSelected([]);setStaffNameId('');setBody('');setReply(null);setFiles([]);setGifIds([]);request.current=null;for(const url of ownedURLs.current)URL.revokeObjectURL(url);ownedURLs.current.clear()}
        accountKey.current=owner;
        try{const saved=JSON.parse(sessionStorage.getItem(`cmpri:staff-name:v2:${value.hotelId}:${value.userId}`)||'null');setStaffName(value.frontDesk&&saved?.name||'');setStaffNameId(value.frontDesk&&saved?.id||'')}catch{setStaffName('');setStaffNameId('')}
      }
      setError("");
      void restoreGIFs([...new Set<string>([...(value.notes||[]),...(value.parents||[])].flatMap((note:Note)=>note.gif_ids||[]))]);
      setData(previous => {
        if (!previous||previous.hotelId!==value.hotelId||previous.userId!==value.userId) return value;
        const notes = [...new Map([...previous.notes, ...value.notes].map((n: Note) => [n.id, n])).values()] as Note[];
        return { ...value, notes, parents: [...new Map([...previous.parents, ...value.parents].map((n: Note) => [n.id, n])).values()],
          tickets: value.tickets, next: before ? value.next : previous.next || value.next };
      });
    } catch (e) { setError(e instanceof Error ? e.message : "Staff Notes could not be loaded."); }
  }, [restoreGIFs]);
  function chooseFiles(selected:File[]){
    if(nameMode||pending)return;
    if(files.length+gifIds.length+selected.length>STAFF_ATTACHMENT_LIMIT){setError('Attach up to 20 files or GIFs per note.');return}
    if(selected.some(f=>f.size<1||f.size>STAFF_FILE_LIMIT)){setError('Files must be between 1 byte and 100 MB each.');return}
    setError('');setFiles(old=>[...old,...selected.map(file=>{const url=URL.createObjectURL(file);ownedURLs.current.add(url);return {id:crypto.randomUUID(),name:file.name,type:file.type||'application/octet-stream',size:file.size,url,file,uploaded:false}})]);
  }
  function chooseGif(gif:GiphyGif){if(files.length+gifIds.length>=STAFF_ATTACHMENT_LIMIT){setError('Attach up to 20 files or GIFs per note.');return}setGifs(old=>({...old,[gif.id]:gif}));setGifIds(old=>old.includes(gif.id)?old:[...old,gif.id]);}
  function removeAttachment(id:string){if(pending)return;if(id.startsWith('gif:')){setGifIds(old=>old.filter(g=>g!==id.slice(4)));return}setFiles(old=>old.filter(f=>{if(f.id!==id)return true;if(f.url){URL.revokeObjectURL(f.url);ownedURLs.current.delete(f.url)}return false}));}
  useEffect(() => { const task = setTimeout(() => void load(), 0); return () => clearTimeout(task); }, [load]);
  useEffect(() => {
    if (!data?.hotelId) return;
    const client = createClient();
    const changed = () => { void invalidateCachedResources(['notes','inbox']).then(() => load()); };
    const channel = client.channel(`staff-notes-board-${crypto.randomUUID()}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "cmpri_staff_notes", filter: `hotel_id=eq.${data.hotelId}` }, changed)
      .on("postgres_changes", {event:"INSERT",schema:"public",table:"cmpri_staff_note_names",filter:`hotel_id=eq.${data.hotelId}`},changed)
      .subscribe(status => { setConnection(status === "SUBSCRIBED" ? "" : "Live updates reconnecting…"); if (status === "SUBSCRIBED") changed(); });
    const stopResources=subscribeResources(['rooms','session','reference'],()=>load(),false);
    const refresh = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => { stopResources();void client.removeChannel(channel); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh); };
  }, [data?.hotelId, load]);
  useLayoutEffect(() => {
    const el = input.current;
    if (el) { el.style.height = "24px"; el.style.height = `${Math.min(120, Math.max(24, el.scrollHeight))}px`; }
    syncMirror();
  }, [body, nameDraft, nameMode, syncMirror]);
  useEffect(() => {
    if (!input.current) return;
    const observer = new ResizeObserver(syncMirror);
    observer.observe(input.current);
    return () => observer.disconnect();
  }, [syncMirror]);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const resize = () => {
      if (compact) {
        const rows = [...el.querySelectorAll<HTMLElement>("[data-staff-note]")].slice(0, 5);
        el.style.maxHeight = rows.length ? `${rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0)}px` : "none";
      } else if (nearBottom.current) el.scrollTop = el.scrollHeight;
    };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(el);
    return () => observer.disconnect();
  }, [data, compact]);
  useEffect(() => {
    if (!data || !list.current) return;
    const seen = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(entries => {
      if (!resourceViewVisible(window)) return;
      for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio >= 0.5) seen.add(entry.target.id.slice(5));
      if (!seen.size || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if(!resourceViewVisible(window)){seen.clear();return;}
        const ids = [...seen]; seen.clear();
        void (async () => {
          const response = await fetch("/api/staff-notes", { method: "PATCH", headers: { ...await authorizationHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids.slice(0, 500) }) });
          if (response.ok) window.top?.dispatchEvent(new Event("cmpri-staff-notes-read"));
        })().catch(() => {});
      }, 100);
    }, { threshold: 0.5 });
    const observe = () => { observer.disconnect(); list.current?.querySelectorAll("[data-staff-note]").forEach(row => observer.observe(row)); };
    const stopVisibility=watchResourceVisibility(window,observe);
    observe(); document.addEventListener("visibilitychange", observe);
    return () => { stopVisibility();observer.disconnect(); clearTimeout(timer); document.removeEventListener("visibilitychange", observe); };
  }, [data]);
  const query=nameMode||composing?null:staffMentionQuery(body,caret);
  const reference=nameMode||composing?null:staffReferenceQuery(body,caret);
  const lookupNumber=reference?.number||((query?.query.match(/^(?:WO\s*[#-]?\s*|work\s+order\s*#?\s*|#)?(\d+)$/i)||[])[1]||'');
  useEffect(()=>{
    if(!lookupNumber)return;
    const abort=new AbortController();
    // One lookup after editing an explicit reference; no recurring refresh/polling.
    const timer=setTimeout(()=>{void(async()=>{
      try{const response=await fetch('/api/work-orders/references?target=number:'+encodeURIComponent(lookupNumber),{headers:await authorizationHeaders(),cache:'no-store',signal:abort.signal});const value=await response.json();if(!response.ok||abort.signal.aborted)return;
        setTicketChoices({number:lookupNumber,targets:(value.tickets||[]).filter((t:{display_id:string})=>workOrderNumber(t.display_id)===lookupNumber).map((t:{id:string;display_id:string;room?:string;issue?:string})=>({id:t.id,kind:'work_order',label:'WO#'+workOrderNumber(t.display_id),description:[t.room,t.issue].filter(Boolean).join(' · '),userIds:[]}))});
      }catch{if(!abort.signal.aborted)setTicketChoices({number:lookupNumber,targets:[]})}
    })()},120);
    return()=>{clearTimeout(timer);abort.abort()};
  },[lookupNumber,data?.hotelId]);
  const candidates=query?staffMentionSuggestions(query.query,data?.mentions||[]):[];
  const ticketTargets=ticketChoices.number===lookupNumber?ticketChoices.targets:[];
  const options=[...candidates,...ticketTargets];
  const showSuggestions=!dismissed&&!nameMode&&!composing&&options.length>0&&Boolean(query||reference);
  const completion=composing||dismissed?null:staffMentionCompletion(body,caret,data?.mentions||[]);
  useLayoutEffect(()=>{
    if(!showSuggestions)return;const option=document.getElementById(suggestionsId+'-'+activeSuggestion%options.length),box=option?.parentElement;
    if(option&&box){if(option.offsetTop<box.scrollTop)box.scrollTop=option.offsetTop;else if(option.offsetTop+option.offsetHeight>box.scrollTop+box.clientHeight)box.scrollTop=option.offsetTop+option.offsetHeight-box.clientHeight}
  },[showSuggestions,activeSuggestion,suggestionsId,options.length]);
  function changeBody(value:string){setSelected(old=>rebaseStaffMentions(body,value,old));setBody(value);setActiveSuggestion(0);setDismissed(false)}
  function acceptMention(target?:StaffMention) {
    const mention=target||(showSuggestions?options[activeSuggestion%options.length]:completion?.mention);
    if(!mention)return false;
    const range=mention.kind==='work_order'&&reference?reference:query;
    if(!range)return false;
    const inserted=mention.kind==='work_order'&&reference?insertStaffReference(body,range,mention,selected):insertStaffMention(body,range,mention,selected);
    setBody(inserted.value);setSelected(inserted.mentions);setCaret(inserted.caret);setDismissed(false);setActiveSuggestion(0);
    requestAnimationFrame(()=>{input.current?.focus();input.current?.setSelectionRange(inserted.caret,inserted.caret);syncMirror()});return true;
  }
  function ranges(text:string,saved:StaffMentionRange[]=[]){
    const valid=selectedStaffMentions(text,saved)||[];
    return [...valid,...staffMentionMatches(text,(data?.mentions||[]).filter(m=>m.kind!=='location'&&m.kind!=='work_order')).filter(m=>!valid.some(v=>v.start<m.end&&v.end>m.start)).map(m=>({start:m.start,end:m.end,...m.mention}))].sort((a,b)=>a.start-b.start);
  }
  function highlightedDraft(from: number, to: number) {
    const matches = ranges(body,selected).map(m=>({start:m.start,end:m.end,label:m.label,tag:false}));
    for(const m of body.matchAll(/#[\p{L}][\p{L}\p{N}_-]*/gu))matches.push({start:m.index!,end:m.index!+m[0].length,label:m[0],tag:true});
    matches.sort((a,b)=>a.start-b.start);
    const parts: React.ReactNode[] = [];
    let at = from;
    for (const match of matches) {
      const start = Math.max(from, match.start), end = Math.min(to, match.end);
      if (start >= end||start<at) continue;
      parts.push(body.slice(at, start), <span key={start} data-composer-mention={match.tag?undefined:match.label} className={match.tag?"staff-note-tag text-sky-300":"rounded bg-sky-400/10 text-sky-300"}>{body.slice(start, end)}</span>);
      at = end;
    }
    parts.push(body.slice(at, to));
    return parts;
  }
  async function confirmName() {
    if(nameMode){
      const value=nameDraft.trim().replace(/\s+/g,' ');if(!value||value.length>80||inFlight.current)return;
      inFlight.current=true;setPending(true);setError('');
      try{const response=await fetch('/api/staff-notes/names',{method:'POST',headers:{...await authorizationHeaders(),'Content-Type':'application/json'},body:JSON.stringify({name:value})});const captured=await response.json();if(!response.ok)throw Error(captured.error);
        setStaffName(captured.name);setStaffNameId(captured.id);setNameDraft('');try{sessionStorage.setItem(`cmpri:staff-name:v2:${data!.hotelId}:${data!.userId}`,JSON.stringify(captured))}catch{}await load();
      }catch(e){setError(e instanceof Error?e.message:'Your name could not be saved. Try again.')}
      finally{inFlight.current=false;setPending(false);requestAnimationFrame(()=>{if(nameInput.current)nameInput.current.focus();else input.current?.focus()})}
    }
  }
  async function post(event?: FormEvent) {
    event?.preventDefault();
    if(nameMode||!data)return;
    if ((!body.trim()&&!files.length&&!gifIds.length)||inFlight.current) return;
    inFlight.current=true;setPending(true);setError('');
    const parent=reply?.id||null,uploadIds=files.map(file=>file.id),fingerprint=JSON.stringify({body,parent,staffName,uploadIds,gifIds,mentions:selected});
    if(!request.current||request.current.fingerprint!==fingerprint)request.current={id:crypto.randomUUID(),fingerprint};
    try{
      for(const item of files){if(!item.uploaded){await uploadStaffNoteFile(item.file,item.id);setFiles(old=>old.map(f=>f.id===item.id?{...f,uploaded:true}:f))}}
      const response=await fetch('/api/staff-notes',{method:'POST',headers:{...await authorizationHeaders(),'Content-Type':'application/json'},body:JSON.stringify({body,parentId:parent,requestId:request.current.id,staffName,uploadIds,gifIds,mentions:selected})});
      const result=await response.json();if(!response.ok)throw Error(result.error);
      for(const file of files)if(file.url){URL.revokeObjectURL(file.url);ownedURLs.current.delete(file.url)}
      setFiles([]);setGifIds([]);setSelected([]);setBody('');setCaret(0);setReply(null);request.current=null;nearBottom.current=true;await load();if(typeof window!=='undefined')window.top?.dispatchEvent(new Event('cmpri-staff-notes-posted'));
    }catch(e){setError(e instanceof Error?e.message:'Post not confirmed. Your draft and attachments are retained.')}
    finally{inFlight.current=false;setPending(false);input.current?.focus()}
  }
  function jump(id: string) {
    if (!document.getElementById(`note-${id}`)) {
      const parent = data?.parents.find(n => n.id === id);
      if (parent) setData(previous => previous ? { ...previous, notes: [...previous.notes, parent] } : previous);
    }
    requestAnimationFrame(() => document.getElementById(`note-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }
  function content(note: Note) {
    const tokens: Array<{ start: number; end: number; node: React.ReactNode }> = [];
    for(const m of ranges(note.body,note.mentions)){
      const ticket=m.kind==='work_order'?data?.targets?.[m.id]:null;
      tokens.push({start:m.start,end:m.end,node:m.kind==='work_order'?(ticket?<a data-staff-target-kind={m.kind} data-staff-target-id={m.id} href={ticket.href} title={ticket.preview} className="text-sky-400 hover:underline">{m.label}</a>:<span data-staff-target-kind={m.kind} data-staff-target-id={m.id} className="text-slate-500">{m.label}</span>):<span data-staff-target-kind={m.kind} data-staff-target-id={m.id} title={staffTargetType(m.kind)} className="rounded bg-sky-400/10 text-sky-300">{note.body.slice(m.start,m.end)}</span>});
    }
    for(const match of note.body.matchAll(/#[\p{L}][\p{L}\p{N}_-]*/gu)) tokens.push({start:match.index!,end:match.index!+match[0].length,node:<span className="staff-note-tag text-sky-300">{match[0]}</span>});
    for (const reference of staffTicketReferences(note.body)) {
      if(tokens.some(t=>t.start<reference.end&&t.end>reference.start))continue;
      const ticket = data?.tickets[reference.number];
      tokens.push({ start: reference.start, end: reference.end, node: ticket ? <a href={ticket.href} title={ticket.preview} className="text-sky-400 hover:underline">{reference.label}</a> : <span className="text-slate-500">{reference.label}</span> });
    }
    let at = 0;
    const output: React.ReactNode[] = [];
    for (const token of tokens.sort((a, b) => a.start - b.start)) { if (token.start < at) continue; output.push(note.body.slice(at, token.start), <span key={token.start}>{token.node}</span>); at = token.end; }
    output.push(note.body.slice(at)); return output;
  }
  const composer = <form onSubmit={post} className="shrink-0 py-1">
    {reply && <div className="flex items-center gap-2 text-xs text-slate-400"><button type="button" onClick={() => jump(reply.id)} title={reply.body}>Replying to {reply.author_name}</button><button type="button" aria-label="Cancel reply" onClick={() => setReply(null)}>×</button></div>}
    <div className="flex items-start gap-1">
      <div role="combobox" aria-controls={suggestionsId} aria-label="Staff Notes mention targets" aria-haspopup="listbox" aria-expanded={showSuggestions} className="staff-compose-shell relative min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 focus-within:border-sky-400">
        {nameMode&&<div className="staff-name-entry"><input ref={nameInput} aria-label="Your actual name" placeholder="Your name" autoComplete="given-name" autoCapitalize="words" maxLength={80} required disabled={pending} value={nameDraft} onChange={e=>setNameDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();void confirmName()}}}/><button type="button" disabled={pending||!nameDraft.trim()} onClick={()=>void confirmName()}>Confirm</button></div>}
        {data?.frontDesk&&!nameMode&&<div className="staff-confirmed-identity"><span>{staffName}</span><span aria-hidden="true">·</span><span>Front Desk</span><button type="button" aria-label="Change name" disabled={pending} onClick={()=>{setStaffName('');setStaffNameId('');setNameDraft('');try{sessionStorage.removeItem(`cmpri:staff-name:v2:${data.hotelId}:${data.userId}`)}catch{}}}>Change</button></div>}
        <div className="relative">
        <textarea ref={input} aria-autocomplete="both" aria-controls={showSuggestions?suggestionsId:undefined} aria-activedescendant={showSuggestions?suggestionsId+'-'+(activeSuggestion%options.length):undefined} aria-label="Write a comment" placeholder={nameMode?"Confirm your name to comment…":"Write a comment… @mention"} value={body} maxLength={4000} rows={1} disabled={pending||!data||nameMode}
          onChange={e => { changeBody(e.target.value);setCaret(e.target.selectionStart); }} onSelect={e => {setCaret(e.currentTarget.selectionStart);}}
          onPaste={e=>{if(e.clipboardData.files.length){e.preventDefault();chooseFiles(Array.from(e.clipboardData.files))}}}
          onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();chooseFiles(Array.from(e.dataTransfer.files))}}
          onScroll={syncMirror}
          onCompositionStart={() => setComposing(true)} onCompositionEnd={e => { setComposing(false); setCaret(e.currentTarget.selectionStart); }}
          onKeyDown={e => { if (composing || e.nativeEvent.isComposing) return; if(showSuggestions&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();setActiveSuggestion(old=>(old+(e.key==='ArrowDown'?1:options.length-1))%options.length);return}
            if(e.key==='Escape'&&showSuggestions){e.preventDefault();setDismissed(true);return}
            if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && !nameMode && (showSuggestions||completion)) { e.preventDefault(); acceptMention(); } else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void post(); } }}
          className="block h-6 min-h-6 w-full resize-none overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 px-2 py-0.5 text-sm leading-tight text-transparent caret-white placeholder:text-slate-400 outline-none focus:border-sky-400" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent">
          <div ref={mirror} className="box-border whitespace-pre-wrap break-words px-2 py-0.5 text-sm leading-tight text-white">
            {completion ? <>{highlightedDraft(0, caret)}<span className="relative"><button type="button" tabIndex={-1} aria-label={`Complete @${completion.mention.label}`} onPointerDown={e => e.preventDefault()} onClick={()=>acceptMention(completion?.mention)} className="pointer-events-auto absolute left-0 top-0 z-10 whitespace-nowrap bg-slate-950 text-slate-500">{completion.suffix}</button></span>{highlightedDraft(caret, body.length)}</> : highlightedDraft(0, body.length)}{"\u200b"}
          </div>
        </div>
        </div>
        <div hidden={!showSuggestions} id={suggestionsId} role="listbox" aria-label="Mention targets" className="staff-mention-options">{options.map((target,index)=><button key={staffTargetKey(target)} id={suggestionsId+'-'+index} type="button" role="option" aria-selected={index===activeSuggestion%options.length} aria-label={`Mention ${target.label} (${staffTargetType(target.kind)})`} onPointerDown={e=>e.preventDefault()} onClick={()=>acceptMention(target)}><span>{target.label}{target.description&&target.description!==target.label?' · '+target.description:''}</span><small>{staffTargetType(target.kind)}</small></button>)}</div>
      </div>
      <StaffNotesMedia disabled={pending||nameMode||!data} onFiles={chooseFiles} onGif={chooseGif} postButton={<button type="submit" disabled={!data||pending||nameMode||(!body.trim()&&!files.length&&!gifIds.length)} className="font-bold">{pending?"…":"Post"}</button>}/>
    </div>
    {files.length+gifIds.length>0&&<StaffNoteAttachments files={files} gifIds={gifIds} gifs={gifs} onRemove={pending?undefined:removeAttachment}/>}
    {error && <p role="alert" className="mt-1 text-xs text-red-300">{error} <button type="button" onClick={() => void load()} className="underline">Reload</button></p>}
  </form>;
  const ordered = [...(data?.notes || [])].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (compact) ordered.reverse();
  const all = new Map([...(data?.parents || []), ...ordered].map(n => [n.id, n]));
  return <section aria-label="Staff Notes" className={"cmpri-staff-notes "+(compact ? "mt-3 min-w-0" : "flex min-h-0 flex-1 flex-col")}>
    {compact && <h2 className="font-bold text-amber-400">Staff Notes</h2>}
    {compact && composer}
    {connection && <p role="status" className="text-xs text-slate-500">{connection}</p>}
    {!compact && data?.next && <button type="button" className="text-xs text-sky-300" onClick={() => void load(data.next!)}>Older comments</button>}
    <div ref={list} className={`${compact ? "" : "min-h-0 flex-1"} overflow-y-auto overscroll-auto`} onScroll={e => { nearBottom.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 60; }}>
      {ordered.map(note => { const parent = note.parent_id ? all.get(note.parent_id) : null; const date = new Date(note.created_at);
        return <div data-reply={Boolean(parent)} key={note.id} id={`note-${note.id}`} data-staff-note className="flex items-start gap-1 border-b border-slate-800 px-2 py-0.5 text-xs leading-tight">
          <button type="button" aria-label={note.author_name} className="staff-note-author shrink-0 font-semibold" title={'Insert @'+note.author_name} onClick={()=>{if(nameMode)return;const target=staffAuthorMention(note,data?.mentions||[]);if(!target)return;const start=input.current?.selectionStart??body.length,end=input.current?.selectionEnd??start,inserted=insertStaffMention(body,{start,end},target,selected);setBody(inserted.value);setSelected(inserted.mentions);setCaret(inserted.caret);requestAnimationFrame(()=>{input.current?.focus();input.current?.setSelectionRange(inserted.caret,inserted.caret)})}}><span className="staff-author-name">{note.author_name}</span>{note.author_name_id&&<span className="staff-front-desk-badge">Front Desk</span>}</button>
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-slate-300">{parent && <button type="button" onClick={() => jump(parent.id)} title={`${parent.author_name}: ${parent.body}`} className="mr-1 text-slate-500 hover:text-sky-300">↪ {parent.author_name}</button>}{content(note)}<StaffNoteAttachments files={note.attachments||[]} gifIds={note.gif_ids||[]} gifs={gifs} onRetry={()=>{void load();void restoreGIFs(note.gif_ids||[])}}/></div>
          <time dateTime={note.created_at} title={date.toLocaleString()} className="shrink-0 text-slate-500">{date.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} <small>{date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</small></time>
          <button type="button" aria-label={`Reply to ${note.author_name}`} title="Reply" className="shrink-0 px-1 text-slate-500 hover:text-sky-300" onClick={() => { setReply(note); input.current?.focus(); }}>↪</button>
        </div>;
      })}
      {data && !ordered.length && <p className="py-2 text-xs text-slate-500">No staff notes yet.</p>}
    </div>
    {compact && data?.next && <button type="button" className="text-xs text-sky-300" onClick={() => void load(data.next!)}>Older comments</button>}
    {!compact && composer}
  </section>;
}
