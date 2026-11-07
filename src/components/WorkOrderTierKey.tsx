"use client";

import { useEffect, useId, useRef, useState } from "react";
import LoyaltyBadge from "@/components/LoyaltyBadge";

const TIERS = ["Titanium", "Platinum", "Gold", "Silver", "Base"] as const;

export default function WorkOrderTierKey() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
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
    {open && <section id={id} className="work-order-tier-popover" aria-label="Marriott Bonvoy membership tiers">
      <h2>Marriott Bonvoy tiers</h2>
      <ol>{TIERS.map(tier => <li key={tier}><LoyaltyBadge tier={tier} /><span>{tier === "Base" ? "Member" : `${tier} Elite`}</span></li>)}</ol>
      <p><LoyaltyBadge tier="Ambassador" /><span>Ambassador Elite is the highest tier, shown by the symbol in the title bar.</span></p>
    </section>}
  </div>;
}
