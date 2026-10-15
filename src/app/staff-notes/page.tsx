"use client";
import StaffNotes from "@/components/StaffNotes";
import ModalDashboardLink from "@/components/ModalDashboardLink";
export default function StaffNotesPage() {
  function close() {
    if (window.parent !== window) window.parent.postMessage({ type: "cmpri-modal-close", modalToken: new URLSearchParams(window.location.search).get("modalToken") || "" }, window.location.origin);
    else window.history.back();
  }
  return <main className="flex h-dvh min-h-0 flex-col bg-slate-950 p-3 text-white">
    <header className="mb-2 flex shrink-0 items-center justify-between gap-3"><h1 className="font-bold text-amber-400">Staff Notes</h1>
      <div className="flex items-center gap-2"><ModalDashboardLink className="text-xs text-sky-300" /><button type="button" aria-label="Close Staff Notes" data-cmpri-modal-close="true" onClick={close} className="grid size-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-800">×</button></div>
    </header><StaffNotes />
  </main>;
}
