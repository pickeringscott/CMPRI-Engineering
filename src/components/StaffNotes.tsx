"use client";
import { sharedFetch as fetch } from "@/lib/events/shared-fetch";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { subscribeResource } from "@/lib/events/browser";
import { staffMentionMatches, staffMentionCompletion, staffTicketReferences, type StaffMention } from "@/lib/staff-notes";

type Note = { id: string; author_name: string; body: string; parent_id: string | null; created_at: string };
type Payload = { notes: Note[]; parents: Note[]; mentions: StaffMention[]; management: boolean; frontDesk: boolean; hotelId: string;
  tickets: Record<string, { href: string; preview: string }>; next: string | null };
export default function StaffNotes({ compact: forcedCompact }: { compact?: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const compact = forcedCompact ?? (data ? !data.management : false);
  const [body, setBody] = useState("");
  const [initials, setInitials] = useState("");
  const [reply, setReply] = useState<Note | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [caret, setCaret] = useState(0);
  const [connection, setConnection] = useState("Connecting…");
  const list = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false), request = useRef<{ id: string; body: string; parent: string | null } | null>(null);
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
  const load = useCallback(async (before?: string) => {
    try {
      const response = await fetch(`/api/staff-notes${before ? `?before=${encodeURIComponent(before)}` : ""}`, { headers: await authorizationHeaders(), cache: "no-store" });
      const value = await response.json();
      if (!response.ok) { if (response.status === 401 || response.status === 403) setData(null); throw new Error(value.error); }
      setData(previous => {
        if (!previous) return value;
        const notes = [...new Map([...previous.notes, ...value.notes].map((n: Note) => [n.id, n])).values()] as Note[];
        return { ...value, notes, parents: [...new Map([...previous.parents, ...value.parents].map((n: Note) => [n.id, n])).values()],
          tickets: value.tickets, next: before ? value.next : previous.next || value.next };
      });
    } catch (e) { setError(e instanceof Error ? e.message : "Staff Notes could not be loaded."); }
  }, []);
  useEffect(() => { const task = setTimeout(() => void load(), 0); return () => clearTimeout(task); }, [load]);
  useEffect(() => {
    if (!data?.hotelId) return;
    return subscribeResource("staff-notes", reason => { if (reason === "reset") { setData(null); setConnection("Reconnecting…"); } else { setConnection(""); void load(); } });
  }, [data?.hotelId, load]);
  useLayoutEffect(() => {
    const el = input.current;
    if (el) { el.style.height = "24px"; el.style.height = `${Math.min(120, Math.max(24, el.scrollHeight))}px`; }
    syncMirror();
  }, [body, syncMirror]);
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
    const matches = staffMentionMatches(body, data?.mentions || []);
    const parts: React.ReactNode[] = [];
    let at = from;
    for (const match of matches) {
      const start = Math.max(from, match.start), end = Math.min(to, match.end);
      if (start >= end) continue;
      parts.push(body.slice(at, start), <span key={start} data-composer-mention={match.mention.label} className="rounded bg-sky-400/10 text-sky-300">{body.slice(start, end)}</span>);
      at = end;
    }
    parts.push(body.slice(at, to));
    return parts;
  }
  async function post(event?: FormEvent) {
    event?.preventDefault();
    if (!body.trim() || inFlight.current) return;
    inFlight.current = true; setPending(true); setError("");
    const parent = reply?.id || null;
    if (!request.current || request.current.body !== body || request.current.parent !== parent) request.current = { id: crypto.randomUUID(), body, parent };
    try {
      const response = await fetch("/api/staff-notes", { method: "POST", headers: { ...await authorizationHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ body, parentId: parent, requestId: request.current.id, initials }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setBody(""); setCaret(0); setReply(null); request.current = null; nearBottom.current = true;
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Post not confirmed. Your draft is retained."); }
    finally { inFlight.current = false; setPending(false); input.current?.focus(); }
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
      {data?.frontDesk && <input aria-label="Your initials" placeholder="Initials" value={initials} maxLength={4} onChange={e => setInitials(e.target.value)} className="h-6 w-14 rounded-lg border border-slate-700 bg-slate-950 px-1 text-xs text-white" />}
      <div className="relative min-w-0 flex-1">
        <textarea ref={input} aria-label="Write a comment" placeholder="Write a comment… @mention" value={body} maxLength={4000} rows={1} disabled={pending}
          onChange={e => { setBody(e.target.value); setCaret(e.target.selectionStart); }} onSelect={e => setCaret(e.currentTarget.selectionStart)}
          onScroll={syncMirror}
          onCompositionStart={() => setComposing(true)} onCompositionEnd={e => { setComposing(false); setCaret(e.currentTarget.selectionStart); }}
          onKeyDown={e => { if (composing || e.nativeEvent.isComposing) return; if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && completion) { e.preventDefault(); acceptMention(); } else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void post(); } }}
          className="block h-6 min-h-6 w-full resize-none overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 px-2 py-0.5 text-sm leading-tight text-transparent caret-white placeholder:text-slate-400 outline-none focus:border-sky-400" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent">
          <div ref={mirror} className="box-border whitespace-pre-wrap break-words px-2 py-0.5 text-sm leading-tight text-white">
            {completion ? <>{highlightedDraft(0, caret)}<span className="relative"><button type="button" tabIndex={-1} aria-label={`Complete @${completion.mention.label}`} onPointerDown={e => e.preventDefault()} onClick={acceptMention} className="pointer-events-auto absolute left-0 top-0 z-10 whitespace-nowrap bg-slate-950 text-slate-500">{completion.suffix}</button></span>{highlightedDraft(caret, body.length)}</> : highlightedDraft(0, body.length)}{"\u200b"}
          </div>
        </div>
      </div>
      <button type="submit" disabled={pending || !body.trim()} className="h-6 w-[76px] shrink-0 rounded-full bg-sky-700 text-[11px] font-bold text-white hover:bg-sky-600 disabled:opacity-50">{pending ? "Posting…" : "Post"}</button>
    </div>
    {error && <p role="alert" className="mt-1 text-xs text-red-300">{error} <button type="button" onClick={() => void load()} className="underline">Reload</button></p>}
  </form>;
  const ordered = [...(data?.notes || [])].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (compact) ordered.reverse();
  const all = new Map([...(data?.parents || []), ...ordered].map(n => [n.id, n]));
  return <section aria-label="Staff Notes" className={compact ? "mt-3 min-w-0" : "flex min-h-0 flex-1 flex-col"}>
    {compact && <h2 className="font-bold text-amber-400">Staff Notes</h2>}
    {compact && composer}
    {connection && <p role="status" className="text-xs text-slate-500">{connection}</p>}
    {!compact && data?.next && <button type="button" className="text-xs text-sky-300" onClick={() => void load(data.next!)}>Older comments</button>}
    <div ref={list} className={`${compact ? "" : "min-h-0 flex-1"} overflow-y-auto overscroll-auto`} onScroll={e => { nearBottom.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 60; }}>
      {ordered.map(note => { const parent = note.parent_id ? all.get(note.parent_id) : null; const date = new Date(note.created_at);
        return <div key={note.id} id={`note-${note.id}`} data-staff-note className="flex items-start gap-1 border-b border-slate-800 px-2 py-0.5 text-xs leading-tight">
          <span className="shrink-0 font-semibold text-sky-200">{note.author_name}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-slate-300">{parent && <button type="button" onClick={() => jump(parent.id)} title={`${parent.author_name}: ${parent.body}`} className="mr-1 text-slate-500 hover:text-sky-300">↪ {parent.author_name}</button>}{content(note)}</span>
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
