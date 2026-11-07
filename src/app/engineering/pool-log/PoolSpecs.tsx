"use client";
import { useId, useRef } from "react";
import { CMPRI_POOL } from "@/lib/pool-log";

export default function PoolSpecs() {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()} className="rounded-lg border px-3 py-2 text-sm font-semibold">Pool Specs</button>
    <dialog ref={dialog} aria-labelledby={title} className="pool-specs">
      <header><h2 id={title}>Pool Specs</h2><button type="button" autoFocus aria-label="Close Pool Specs" onClick={() => dialog.current?.close()}>×</button></header>
      <div className="pool-specs-body">
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm print:border-black print:bg-white">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <div><span className="text-slate-400 print:text-black">Inspection volume</span><div className="font-bold">{CMPRI_POOL.inspectionVolumeGallons.toLocaleString()} gal</div></div>
            <div><span className="text-slate-400 print:text-black">Chemical dosing basis</span><div className="font-bold">{CMPRI_POOL.dosingBasisGallons.toLocaleString()} gal</div></div>
            <div><span className="text-slate-400 print:text-black">Required flow</span><div className="font-bold">{CMPRI_POOL.requiredFlowGpm} GPM</div></div>
            <div><span className="text-slate-400 print:text-black">Observed 06/23/2026</span><div className="font-bold">{CMPRI_POOL.observedFlowGpm20260623} GPM</div></div>
          </div>
          <p className="mt-3 text-xs text-slate-400 print:text-black">One water sample per test. Readings are still taken AM and PM: each sample&apos;s pH + bromine is recorded for both the shallow and deep fields, as one shared sample with collection location unspecified. Water temperature, flow rate, main drain, and filter backwash are daily checks recorded once per day. The PM sample can be added later without changing the saved AM readings. This page records results only—it does not calculate chemical doses or certify pool opening.</p>
        </section>
      </div>
    </dialog>
  </>;
}
