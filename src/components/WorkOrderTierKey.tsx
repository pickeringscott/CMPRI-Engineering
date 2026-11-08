"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import LoyaltyBadge from "@/components/LoyaltyBadge";

const TIERS = ["Titanium", "Platinum", "Gold", "Silver", "Base"] as const;

export default function WorkOrderTierKey() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const box = trigger.current?.getBoundingClientRect(), panel = popover.current;
      if (!box || !panel) return;
      const theme = getComputedStyle(trigger.current!);
      for (const name of ['--cmpri-outline','--cmpri-modal-surface','--cmpri-modal-text']) panel.style.setProperty(name, theme.getPropertyValue(name));
      panel.style.position = 'fixed';panel.style.right = 'auto';panel.style.zIndex = '10000';
      panel.style.maxWidth = 'calc(100vw - 16px)';panel.style.maxHeight = 'calc(100dvh - 16px)';panel.style.overflowY = 'auto';
      panel.style.left = Math.max(8, Math.min(box.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8)) + 'px';
      panel.style.top = Math.max(8, Math.min(box.bottom + 5, innerHeight - panel.offsetHeight - 8)) + 'px';
    }
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return () => { window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setOpen(false);
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

  return <div ref={root} className="work-order-tier-key" onPointerDown={event => event.stopPropagation()}>
    <button ref={trigger} type="button" className="work-order-tier-help" aria-label="Marriott Bonvoy membership tier key" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <LoyaltyBadge tier="Ambassador" />
      <span className="work-order-tier-question" aria-hidden="true">?</span>
    </button>
    {open && createPortal(<section ref={popover} id={id} className="work-order-tier-popover" aria-label="Marriott Bonvoy membership tiers">
      <h2>Marriott Bonvoy tiers</h2>
      <ol>{TIERS.map(tier => <li key={tier}><LoyaltyBadge tier={tier} /><span>{tier === "Base" ? "Member" : `${tier} Elite`}</span></li>)}</ol>
      <p><LoyaltyBadge tier="Ambassador" /><span>Ambassador Elite is the highest tier, shown by the symbol in the title bar.</span></p>
    </section>, document.body)}
  </div>;
}
