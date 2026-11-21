"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";


import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import TicketEscalationMark from "./TicketEscalationMark";
import styles from "./RoomRankerKey.module.css";

export default function RoomRankerKey() {
  const { t, tt } = useUiLanguage();
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
      event.preventDefault();
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
    <button ref={trigger} type="button" className={styles.trigger} aria-label={t("Room ranker key")} title={tt("Room Ranker Help")} aria-expanded={open} aria-controls={id} onPointerDown={event => event.stopPropagation()} onClick={event => { setContainer(event.currentTarget.closest<HTMLElement>("[data-cmpri-modal-theme]") || event.currentTarget.closest<HTMLElement>("main")); setOpen(value => !value); }}>?</button>
    {open && container && createPortal(<section ref={panel} id={id} className={styles.panel} aria-label={t("Room ranker key")}>
      <button type="button" className={styles.close} aria-label={t("Close room ranker key")} onClick={() => { setOpen(false); trigger.current?.focus(); }}>×</button>
      <h2>{t("Room ranker key")}</h2>
      <p>{t("Room Ranker helps you see which rooms need attention. Each room gets an A, B, or C based on its unfinished tickets. C needs the most attention.")}</p>
      <ul>
        <li><strong>{t("A — Little or no work needed:")}</strong>{t(" No tickets, or just 1–2 Low-priority tickets. No Medium, High, or Urgent tickets.")}</li>
        <li><strong>{t("B — Needs attention:")}</strong>{t(" 3 Low-priority tickets or 1–2 Medium-priority tickets, unless the room meets a C rule below.")}</li>
        <li><strong>{t("C — Needs the most attention:")}</strong>{t(" 4 or more Low-priority tickets, 3 or more Medium-priority tickets, or even one High or Urgent ticket.")}</li>
      </ul>
      <p>{t("If a room fits more than one rule, it gets the rank that needs more attention. Low and Medium tickets are counted separately, using each ticket's original priority.")}</p>
      <h3>{t("Why did a ticket's priority go up?")}</h3>
      <p>{t("Several small problems in one room can add up. With 3 Low-priority tickets, those Low tickets are automatically raised to Medium. With 4 or more Low tickets, those Low tickets are raised to Urgent. With 3 or more Medium tickets, those Medium tickets are raised to Urgent.")}</p>
      <p className={styles.escalation}><TicketEscalationMark /><span><strong>{t("Ticket Escalation:")}</strong>{t(" This red mark means at least one ticket in the room has been raised automatically. Point to it to see the alert, or tap it on a phone.")}</span></p>
      <p>{t("As tickets are finished and fewer problems remain, automatically raised tickets return to their original priority. The room's rank updates too. Tickets marked Completed, Closed, or Will Not Do do not count.")}</p>
      <h3>{t("Using the list")}</h3>
      <p>{t("Open a floor to see its rooms. Use A, B, or C at the top to show only that rank. The highest-priority ticket is shown beside each room; click its title to open it.")}</p>
      <p>{t("Point to ")}<strong>{t("+N more")}</strong>{t(" to see the other ticket titles. Click it to open the full list of additional tickets. Close that list with Close, Escape, or a click outside it.")}</p>
    </section>, container)}
  </>;
}
