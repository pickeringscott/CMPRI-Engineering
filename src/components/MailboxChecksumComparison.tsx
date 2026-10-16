"use client";
import { useRef, useState } from "react";
import { submitMailboxComparison } from "@/lib/mailbox-comparison-client";

export default function MailboxChecksumComparison({ token }: { token: () => Promise<string> }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<boolean[] | null>(null);
  const [error, setError] = useState("");
  async function compare() {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(""); setResult(null);
    const raw = input.current?.value ?? "";
    if (input.current) input.current.value = "";
    try { setResult(await submitMailboxComparison(raw, token)); }
    catch (error) { setError(error instanceof Error ? error.message : "Comparison unavailable."); }
    finally { busy.current = false; setPending(false); }
  }
  return <details className="mt-4 rounded-xl border border-slate-700 bg-slate-900 p-4" onToggle={event=>{if(!event.currentTarget.open){if(input.current)input.current.value="";setResult(null);setError("");}}}>
    <summary className="cursor-pointer font-semibold">Compare mailbox credentials</summary>
    <p className="mt-3 text-sm text-slate-300">Run the private hashing utility, then paste its reference JSON here. Enter only digests, never the client secret or refresh token. This comparison does not contact Google or scan your mailbox.</p>
    <label htmlFor="mailbox-reference-json" className="mt-3 block text-sm font-semibold">Reference JSON</label>
    <textarea ref={input} id="mailbox-reference-json" rows={4} maxLength={512} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} disabled={pending} className="mt-2 w-full rounded-lg border border-slate-600 bg-slate-950 p-3 text-sm" />
    <button type="button" disabled={pending} onClick={()=>void compare()} className="mt-2 rounded-lg border border-cyan-500 px-4 py-2 text-sm font-semibold disabled:opacity-50">{pending ? "Comparing..." : "Compare"}</button>
    <p className="mt-2 text-xs text-slate-400">The input clears when submitted or closed. Only match results are shown; reference digests are not saved by CMPRI.</p>
    <div aria-live="polite" className="mt-3 text-sm">
      {error && <p className="text-amber-200">{error}</p>}
      {result && <><ul className="space-y-1">{["Stored client secret","Prepared client secret","Stored refresh token","Prepared refresh token"].map((label,index)=><li key={label}>{label}: <strong>{result[index] ? "Match" : "Mismatch"}</strong></li>)}</ul><p className="mt-2 text-slate-300">Prepared values are checked immediately before fetch, without sending it. A mismatch establishes different values; it does not establish why they differ.</p></>}
    </div>
  </details>;
}
