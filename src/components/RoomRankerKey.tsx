"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./RoomRankerKey.module.css";

export default function RoomRankerKey() {
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  return <>
    <button ref={trigger} type="button" className={styles.trigger} aria-label="Room ranker key" aria-expanded={open} aria-controls={id} onPointerDown={event => event.stopPropagation()} onClick={event => { setContainer(event.currentTarget.closest<HTMLElement>("[data-cmpri-modal-theme]")); setOpen(value => !value); }}>?</button>
    {open && container && createPortal(<section ref={panel} id={id} className={styles.panel} aria-label="Room ranker key">
      <button type="button" className={styles.close} aria-label="Close room ranker key" onClick={() => { setOpen(false); trigger.current?.focus(); }}>×</button>
      <h2>Room ranker key</h2>
      <p>Ranks use active tickets and their base priorities. The highest applicable rank wins.</p>
      <ul>
        <li><strong>A</strong> — Fewer than 3 Low tickets and no higher-priority tickets.</li>
        <li><strong>B</strong> — 3 Low tickets or 1–2 Medium tickets.</li>
        <li><strong>C</strong> — 4 or more Low tickets, 3 or more Medium tickets, or any High or Urgent ticket.</li>
      </ul>
      <p>At 3 Low tickets, affected tickets rise to Medium. At 4 Low or 3 Medium, affected tickets rise to Urgent. They return to their base priority as the room improves.</p>
      <p>Completed, Closed, and Will Not Do tickets are excluded.</p>
    </section>, container)}
  </>;
}
