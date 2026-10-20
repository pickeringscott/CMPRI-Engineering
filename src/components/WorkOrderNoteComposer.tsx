"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatWorkOrder, workOrderReferences } from "@/lib/work-order-reference.js";
import { workOrderStaffMentions, workOrderMentionQuery, insertWorkOrderMention, type WorkOrderMention } from "@/lib/work-order-mentions";
import { plainTextParts } from "@/lib/plain-text-links";

export type MentionTicket = { id: string; display_id?: string | null; room?: string | null; issue?: string | null; status?: string | null };
type Choice = { key: string; label: string; detail: string };

export default function WorkOrderNoteComposer({ value, onChange, mentions, tickets, disabled = false }: {
  value: string; disabled?: boolean; onChange: (value: string) => void; mentions: readonly WorkOrderMention[]; tickets: readonly MentionTicket[];
}) {
  const input = useRef<HTMLTextAreaElement>(null), mirror = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [composing, setComposing] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0);
  const range = disabled || composing || dismissed || !focused ? null : workOrderMentionQuery(value, caret);
  const choices: Choice[] = [];
  if (range) {
    for (const mention of mentions) if (mention.label.toLocaleLowerCase().startsWith(range.query)) {
      choices.push({ key: `${mention.kind}:${mention.label}`, label: mention.label, detail: mention.kind === "staff" ? "Staff" : "Role" });
    }
    for (const ticket of tickets) {
      const label = formatWorkOrder(ticket.display_id, `WO-${ticket.id.slice(0, 8)}`);
      if ([label, ticket.display_id, ticket.room, ticket.issue, ticket.status, ticket.id.slice(0, 8)].filter(Boolean).join(" ").toLocaleLowerCase().includes(range.query)) {
        choices.push({ key: ticket.id, label, detail: [ticket.room, ticket.issue].filter(Boolean).join(" · ") });
      }
    }
  }
  // Completed mentions need no dropdown; typing a longer role title still works.
  const exact = range && [...mentions, ...choices].some(choice => choice.label.toLocaleLowerCase() === range.query.trim());
  const suggestions = exact ? [] : choices;
  const active = Math.min(selected, Math.max(0, suggestions.length - 1));

  const syncMirror = useCallback(() => {
    const el = input.current, copy = mirror.current;
    if (!el || !copy) return;
    const style = window.getComputedStyle(el);
    for (const property of ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "word-spacing", "padding", "text-indent", "tab-size", "overflow-wrap", "word-break"]) copy.style.setProperty(property, style.getPropertyValue(property));
    copy.style.width = `${el.clientWidth}px`;
    copy.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
  }, []);
  useLayoutEffect(syncMirror, [value, syncMirror]);
  useEffect(() => {
    if (!input.current) return;
    const observer = new ResizeObserver(syncMirror); observer.observe(input.current);
    return () => observer.disconnect();
  }, [syncMirror]);

  function accept(choice: Choice) {
    if (!range) return;
    const inserted = insertWorkOrderMention(value, range, choice.label);
    onChange(inserted.value); setCaret(inserted.caret); setDismissed(true);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(inserted.caret, inserted.caret); syncMirror(); });
  }
  const urls = plainTextParts(value).filter(part => part.href);
  const tokens = [...workOrderStaffMentions(value, mentions), ...workOrderReferences(value).filter(ref => !urls.some(url => ref.start < url.end && ref.end > url.start))].sort((a, b) => a.start - b.start);
  for (const match of value.matchAll(/@(?:WO-)?[a-f0-9-]{8,36}\b/gi)) {
    const start = match.index!, end = start + match[0].length;
    const prefix = match[0].replace(/^@(?:WO-)?/i, "").replaceAll("-", "").toLowerCase();
    if (!tokens.some(token => start < token.end && end > token.start) && !urls.some(url => start < url.end && end > url.start)
      && tickets.some(ticket => ticket.id.replaceAll("-", "").toLowerCase().startsWith(prefix))) tokens.push({ start, end, number: "", label: match[0] });
  }
  tokens.sort((a, b) => a.start - b.start);
  const highlighted: React.ReactNode[] = [];
  let at = 0;
  for (const token of tokens) {
    if (token.start < at) continue;
    highlighted.push(value.slice(at, token.start), <span key={token.start} data-composer-mention className="rounded bg-sky-400/10 text-sky-300">{value.slice(token.start, token.end)}</span>);
    at = token.end;
  }
  highlighted.push(value.slice(at));
  return <div className="relative mt-2">
    <textarea id="technician-note-editor" disabled={disabled} ref={input} aria-label="Work order note" aria-autocomplete="list" aria-controls="work-order-mention-options" aria-haspopup="listbox" aria-activedescendant={suggestions.length ? `work-order-mention-${active}` : undefined}
      value={value} rows={2} placeholder="Document work or type @ to mention staff, a role, or another ticket…"
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onChange={event => { onChange(event.target.value); setCaret(event.target.selectionStart); setSelected(0); setDismissed(false); }}
      onSelect={event => { setCaret(event.currentTarget.selectionStart); setDismissed(false); }} onScroll={syncMirror}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={event => { setComposing(false); setCaret(event.currentTarget.selectionStart); }}
      onKeyDown={event => {
        if (composing || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { setDismissed(true); return; }
        if (!suggestions.length) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected((active + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length); }
        else if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) { event.preventDefault(); accept(suggestions[active]); }
      }}
      className="block max-h-20 w-full resize-none overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-transparent caret-white outline-none placeholder:text-slate-600 focus:border-sky-400" />
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent">
      <div ref={mirror} className="box-border whitespace-pre-wrap break-words p-2 text-sm text-white">{highlighted}{"\u200b"}</div>
    </div>
    {suggestions.length > 0 && <div id="work-order-mention-options" role="listbox" aria-label="Mention staff, roles or tickets" className="absolute left-0 right-0 top-full z-30 mt-1 max-h-48 overflow-y-auto rounded-xl border border-slate-600 bg-slate-900 p-1 shadow-2xl">
      {suggestions.map((choice, index) => <button id={`work-order-mention-${index}`} role="option" aria-selected={index === active} key={choice.key} type="button" tabIndex={-1}
        onPointerDown={event => event.preventDefault()} onClick={() => accept(choice)} className={`block w-full rounded-lg px-2.5 py-2 text-left hover:bg-sky-900/45 ${index === active ? "bg-sky-900/45" : ""}`}>
        <span className="font-semibold text-sky-200">@{choice.label}</span><span className="ml-2 text-sm text-slate-400">{choice.detail}</span>
      </button>)}
    </div>}
  </div>;
}
