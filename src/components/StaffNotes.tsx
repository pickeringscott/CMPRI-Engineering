"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { createClient } from "@/lib/supabase/client";
import StaffNotesMedia,{StaffNoteAttachments} from './StaffNotesMedia';
import {STAFF_FILE_LIMIT,STAFF_ATTACHMENT_LIMIT,type StaffAttachment} from '@/lib/staff-note-media';
import {uploadStaffNoteFile} from '@/lib/staff-note-upload';
import {requestGiphy,type GiphyGif} from '@/lib/giphy';
import { staffMentionMatches, staffMentionCompletion, staffTicketReferences, type StaffMention } from "@/lib/staff-notes";

type Note = { id: string; author_name: string; body: string; parent_id: string | null; created_at: string; attachments?:StaffAttachment[]; gif_ids?:string[] };
type Payload = { notes: Note[]; parents: Note[]; mentions: StaffMention[]; management: boolean; frontDesk: boolean; hotelId: string; userId?:string;
  tickets: Record<string, { href: string; preview: string }>; next: string | null };
export default function StaffNotes({ compact: forcedCompact }: { compact?: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const compact = forcedCompact === true;
  const [body, setBody] = useState("");
  const [staffName,setStaffName]=useState(''),[nameDraft,setNameDraft]=useState('');
  const [files,setFiles]=useState<Array<StaffAttachment & {file:File;uploaded:boolean}>>([]),[gifIds,setGifIds]=useState<string[]>([]),[gifs,setGifs]=useState<Record<string,GiphyGif>>({});
  const nameMode=Boolean(data?.frontDesk&&!staffName);
  const ownedURLs=useRef(new Set<string>()),accountKey=useRef('');
  useEffect(()=>{const urls=ownedURLs.current;return()=>{for(const url of urls)URL.revokeObjectURL(url)}},[]);
  const [reply, setReply] = useState<Note | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [caret, setCaret] = useState(0);
  const [connection, setConnection] = useState("Connecting…");
  const list = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false), request = useRef<{ id: string; fingerprint:string } | null>(null);
  const nearBottom = useRef(true);
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
    try {
      const response = await fetch(`/api/staff-notes${before ? `?before=${encodeURIComponent(before)}` : ""}`, { headers: await authorizationHeaders(), cache: "no-store" });
      const value = await response.json();
      if (!response.ok) { if (response.status === 401 || response.status === 403) setData(null); throw new Error(value.error); }
      const owner=value.hotelId+':'+value.userId+':'+value.frontDesk;
      if(owner!==accountKey.current){
        if(accountKey.current){setBody('');setReply(null);setFiles([]);setGifIds([]);request.current=null;for(const url of ownedURLs.current)URL.revokeObjectURL(url);ownedURLs.current.clear()}
        accountKey.current=owner;
        try{setStaffName(value.frontDesk?sessionStorage.getItem(`cmpri:staff-name:${value.hotelId}:${value.userId}`)||'':'')}catch{setStaffName('')}
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
    const channel = client.channel(`staff-notes-board-${crypto.randomUUID()}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "cmpri_staff_notes", filter: `hotel_id=eq.${data.hotelId}` }, () => void load())
      .subscribe(status => { setConnection(status === "SUBSCRIBED" ? "" : "Live updates reconnecting…"); if (status === "SUBSCRIBED") void load(); });
    const refresh = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => { void client.removeChannel(channel); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh); };
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
      if (document.hidden) return;
      for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio >= 0.5) seen.add(entry.target.id.slice(5));
      if (!seen.size || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const ids = [...seen]; seen.clear();
        void (async () => {
          const response = await fetch("/api/staff-notes", { method: "PATCH", headers: { ...await authorizationHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids.slice(0, 500) }) });
          if (response.ok) window.top?.dispatchEvent(new Event("cmpri-staff-notes-read"));
        })().catch(() => {});
      }, 100);
    }, { threshold: 0.5 });
    const observe = () => { observer.disconnect(); list.current?.querySelectorAll("[data-staff-note]").forEach(row => observer.observe(row)); };
    observe(); document.addEventListener("visibilitychange", observe);
    return () => { observer.disconnect(); clearTimeout(timer); document.removeEventListener("visibilitychange", observe); };
  }, [data]);
  const completion = composing ? null : staffMentionCompletion(body, caret, data?.mentions || []);
  function acceptMention() {
    if (!completion) return false;
    const value = body.slice(0, completion.start) + completion.mention.label + " " + body.slice(caret);
    const position = completion.start + completion.mention.label.length + 1;
    setBody(value); setCaret(position);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(position, position); syncMirror(); });
    return true;
  }
  function highlightedDraft(from: number, to: number) {
    const matches = staffMentionMatches(body, data?.mentions || []).map(m=>({start:m.start,end:m.end,label:m.mention.label,tag:false}));
    for(const m of body.matchAll(/#[\p{L}][\p{L}\p{N}_-]*/gu))matches.push({start:m.index!,end:m.index!+m[0].length,label:m[0],tag:true});
    matches.sort((a,b)=>a.start-b.start);
    const parts: React.ReactNode[] = [];
    let at = from;
    for (const match of matches) {
      const start = Math.max(from, match.start), end = Math.min(to, match.end);
      if (start >= end) continue;
      parts.push(body.slice(at, start), <span key={start} data-composer-mention={match.tag?undefined:match.label} className={match.tag?"staff-note-tag text-sky-300":"rounded bg-sky-400/10 text-sky-300"}>{body.slice(start, end)}</span>);
      at = end;
    }
    parts.push(body.slice(at, to));
    return parts;
  }
  async function post(event?: FormEvent) {
    event?.preventDefault();
    if(nameMode){const value=nameDraft.trim().replace(/\s+/g,' ');if(!value||value.length>80)return;setStaffName(value);setNameDraft('');try{sessionStorage.setItem(`cmpri:staff-name:${data!.hotelId}:${data!.userId}`,value)}catch{}input.current?.focus();return}
    if ((!body.trim()&&!files.length&&!gifIds.length)||inFlight.current) return;
    inFlight.current=true;setPending(true);setError('');
    const parent=reply?.id||null,uploadIds=files.map(file=>file.id),fingerprint=JSON.stringify({body,parent,staffName,uploadIds,gifIds});
    if(!request.current||request.current.fingerprint!==fingerprint)request.current={id:crypto.randomUUID(),fingerprint};
    try{
      for(const item of files){if(!item.uploaded){await uploadStaffNoteFile(item.file,item.id);setFiles(old=>old.map(f=>f.id===item.id?{...f,uploaded:true}:f))}}
      const response=await fetch('/api/staff-notes',{method:'POST',headers:{...await authorizationHeaders(),'Content-Type':'application/json'},body:JSON.stringify({body,parentId:parent,requestId:request.current.id,staffName,uploadIds,gifIds})});
      const result=await response.json();if(!response.ok)throw Error(result.error);
      for(const file of files)if(file.url){URL.revokeObjectURL(file.url);ownedURLs.current.delete(file.url)}
      setFiles([]);setGifIds([]);setBody('');setCaret(0);setReply(null);request.current=null;nearBottom.current=true;await load();
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
    for (const m of staffMentionMatches(note.body, data?.mentions || [])) tokens.push({ start: m.start, end: m.end, node: <span className="rounded bg-sky-400/10 text-sky-300">{note.body.slice(m.start, m.end)}</span> });
    for(const match of note.body.matchAll(/#[\p{L}][\p{L}\p{N}_-]*/gu)) tokens.push({start:match.index!,end:match.index!+match[0].length,node:<span className="staff-note-tag text-sky-300">{match[0]}</span>});
    for (const reference of staffTicketReferences(note.body)) {
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
      <div className="relative min-w-0 flex-1">
        <textarea ref={input} aria-label={nameMode?"Your name":"Write a comment"} placeholder={nameMode?"Enter your name…":"Write a comment… @mention"} value={nameMode?nameDraft:body} maxLength={nameMode?80:4000} rows={1} disabled={pending}
          onChange={e => { if(nameMode)setNameDraft(e.target.value);else setBody(e.target.value);setCaret(e.target.selectionStart); }} onSelect={e => setCaret(e.currentTarget.selectionStart)}
          onPaste={e=>{if(e.clipboardData.files.length){e.preventDefault();chooseFiles(Array.from(e.clipboardData.files))}}}
          onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();chooseFiles(Array.from(e.dataTransfer.files))}}
          onScroll={syncMirror}
          onCompositionStart={() => setComposing(true)} onCompositionEnd={e => { setComposing(false); setCaret(e.currentTarget.selectionStart); }}
          onKeyDown={e => { if (composing || e.nativeEvent.isComposing) return; if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && !nameMode && completion) { e.preventDefault(); acceptMention(); } else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void post(); } }}
          className="block h-6 min-h-6 w-full resize-none overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 px-2 py-0.5 text-sm leading-tight text-transparent caret-white placeholder:text-slate-400 outline-none focus:border-sky-400" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent">
          <div ref={mirror} className="box-border whitespace-pre-wrap break-words px-2 py-0.5 text-sm leading-tight text-white">
            {nameMode?nameDraft:completion ? <>{highlightedDraft(0, caret)}<span className="relative"><button type="button" tabIndex={-1} aria-label={`Complete @${completion.mention.label}`} onPointerDown={e => e.preventDefault()} onClick={acceptMention} className="pointer-events-auto absolute left-0 top-0 z-10 whitespace-nowrap bg-slate-950 text-slate-500">{completion.suffix}</button></span>{highlightedDraft(caret, body.length)}</> : highlightedDraft(0, body.length)}{"\u200b"}
          </div>
        </div>
      </div>
      <StaffNotesMedia disabled={pending||nameMode} onFiles={chooseFiles} onGif={chooseGif} postButton={<button type="submit" disabled={pending||(nameMode?!nameDraft.trim():!body.trim()&&!files.length&&!gifIds.length)} className="font-bold">{nameMode?"OK":pending?"…":"Post"}</button>}/>
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
          <button type="button" className="staff-note-author shrink-0 font-semibold" title={'Insert @'+note.author_name} onClick={()=>{if(nameMode)return;const start=input.current?.selectionStart??body.length;setBody(body.slice(0,start)+'@'+note.author_name+' '+body.slice(start));input.current?.focus()}}>{note.author_name}</button>
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
