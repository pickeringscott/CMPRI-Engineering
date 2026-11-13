"use client";

import { useId, useState } from "react";
import TicketEscalationMark from "./TicketEscalationMark";
import styles from "./TicketEscalation.module.css";

export default function TicketEscalationIndicator() {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <span className={styles.indicator} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <button type="button" className={styles.trigger} aria-label="Ticket Escalation" aria-describedby={open ? id : undefined} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)} onKeyDownCapture={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}><TicketEscalationMark /></button>
    {open && <span id={id} role="tooltip" className={styles.tooltip}><TicketEscalationMark /><span>Ticket Escalation</span><TicketEscalationMark /></span>}
  </span>;
}
