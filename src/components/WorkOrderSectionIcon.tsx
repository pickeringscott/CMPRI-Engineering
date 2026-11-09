type Section = "report" | "notes" | "troubleshooting" | "labor" | "maintenance";

/** Decorative section markers; the adjacent heading supplies the accessible name. */
export default function WorkOrderSectionIcon({ section }: { section: Section }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="mr-1.5 inline-block size-4 align-[-0.15em] text-amber-400">
      {section === "report" && <><rect x="5" y="4" width="14" height="17" rx="2" /><rect x="9" y="2" width="6" height="4" rx="1" /><path d="M9 10h6M9 14h6M9 18h4" /></>}
      {section === "notes" && <><path d="M5 4h14v12H9l-4 4V4Z" /><path d="M8 8h8M8 12h6" /></>}
      {section === "troubleshooting" && <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5M10.5 7v4M10.5 13.5h.01" /></>}
      {section === "labor" && <><path d="M14.8 5.2a5 5 0 0 0-6.5 6.5L3.7 16.3a2.8 2.8 0 0 0 4 4l4.6-4.6a5 5 0 0 0 6.5-6.5l-3 3-3-3 3-3Z" /></>}
      {section === "maintenance" && <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 9h18M8 15l2.5 2.5L16 12" /></>}
    </svg>
  );
}
