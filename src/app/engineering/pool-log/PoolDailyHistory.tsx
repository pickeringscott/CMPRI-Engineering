"use client";

import { bromineBands, poolLocationReadings, sampleLocationLabel } from "@/lib/pool-log";

export type PoolDailyEntry = {
  id: string;
  kind: "reading" | "open" | "close" | "clear-manual";
  recorded_at: string;
  actor_name?: string | null;
  reason?: string | null;
  snapshot?: Record<string, unknown> | null;
  previous_snapshot?: Record<string, unknown> | null;
  source?: "audit" | "current";
};

function present(value: unknown) { return value !== null && value !== undefined && value !== ""; }
function bromine(value: unknown) {
  return bromineBands.find(([band]) => band === value)?.[1] ?? `${String(value)} ppm`;
}

/** Audit snapshots are cumulative; describe only values changed in this revision. */
export function poolSnapshotDescription(snapshot: Record<string, unknown>, previous: Record<string, unknown> = {}) {
  const parts: string[] = [];
  const changed = (key: string) => JSON.stringify(snapshot[key] ?? null) !== JSON.stringify(previous[key] ?? null);
  for (const period of ["am", "pm"] as const) {
    const label = period.toUpperCase();
    const phKey = `ph_${period}`, bandKey = `sanitizer_band_${period}`, numericBandKey = `sanitizer_${period}`;
    const ph = snapshot[phKey], band = snapshot[bandKey] ?? snapshot[numericBandKey];
    if (changed(phKey)) parts.push(`${label} pH ${present(ph) ? String(ph) : "cleared"}`);
    if (changed(bandKey) || changed(numericBandKey)) parts.push(`${label} bromine ${present(band) ? bromine(band) : "cleared"}`);
    if (changed(`sample_location_${period}`)) parts.push(`${label} sample ${sampleLocationLabel(snapshot[`sample_location_${period}`])}`);
    const locations: ReadonlyArray<readonly [string, string]> = [
      ...poolLocationReadings.filter(([key]) => key.endsWith(`_${period}`)),
      [`ph_middle_${period}`, `${label} middle pH`],
      [`sanitizer_middle_${period}`, `${label} middle bromine (ppm)`],
    ];
    for (const [key, name] of locations) {
      if (!changed(key)) continue;
      const value = snapshot[key];
      if (!present(value)) { if (present(previous[key])) parts.push(`${name}: cleared`); continue; }
      const generic = key.startsWith("ph_") ? ph : band;
      // Shared-sample copies repeat the generic result; preserve distinct historical values.
      if (present(generic) && String(value) === String(generic)) continue;
      parts.push(`${name}: ${String(value)}`);
    }
  }
  const retest = snapshot.retest_submission;
  const previousRetest = previous.retest_submission;
  if (retest && typeof retest === "object" && JSON.stringify(retest) !== JSON.stringify(previousRetest)) {
    const reading = retest as Record<string, unknown>;
    if (present(reading.ph)) parts.push(`Retest pH ${String(reading.ph)}`);
    if (present(reading.sanitizer_band ?? reading.sanitizer)) parts.push(`Retest bromine ${bromine(reading.sanitizer_band ?? reading.sanitizer)}`);
    if (present(reading.sample_location)) parts.push(`Retest sample ${sampleLocationLabel(reading.sample_location)}`);
  }
  if (changed("temperature_f")) parts.push(`Water ${present(snapshot.temperature_f) ? `${String(snapshot.temperature_f)}°F` : "cleared"}`);
  if (changed("flow_rate_gpm")) parts.push(`Flow ${present(snapshot.flow_rate_gpm) ? `${String(snapshot.flow_rate_gpm)} GPM` : "cleared"}`);
  for (const [key, label] of [["main_drain_visible", "Main drain visible"], ["filter_backwashed", "Filter backwashed"], ["requires_attention", "Attention needed"]] as const) {
    if (changed(key)) parts.push(`${label}: ${snapshot[key] === true ? "Yes" : snapshot[key] === false ? "No" : "cleared"}`);
  }
  if (changed("closure_reason")) {
    const reason = String(snapshot.closure_reason || ""), prior = String(previous.closure_reason || "");
    const added = prior && reason.startsWith(`${prior}\n`) ? reason.slice(prior.length).trimStart() : reason;
    parts.push(`Closure: ${added || "cleared"}`);
  }
  if (changed("remarks")) {
    const notes = String(snapshot.remarks || ""), prior = String(previous.remarks || "");
    const added = prior && notes.startsWith(`${prior}\n`) ? notes.slice(prior.length).trimStart() : notes;
    parts.push(`Notes: ${added || "cleared"}`);
  }
  return parts.join(" · ") || "Pool log updated";
}

export default function PoolDailyHistory({ entries, error, loading, onRetry }: { entries: PoolDailyEntry[]; error?: string; loading?: boolean; onRetry?: () => void }) {
  return <section aria-label="Daily pool activity" className="rounded-lg border border-slate-700 bg-slate-900 p-2">
    <h2 className="text-sm font-bold">Daily pool activity</h2>
    {loading ? <p role="status" className="mt-1 text-xs text-slate-400">Loading pool activity…</p> : error ? <p role="alert" className="mt-1 text-xs text-amber-200">{error}{onRetry && <> <button type="button" className="underline" onClick={onRetry}>Retry activity</button></>}</p> : entries.length ? <div className="mt-1 max-h-48 overflow-y-auto rounded border border-slate-700 bg-slate-950">
      {entries.map(entry => {
        const instant = new Date(entry.recorded_at);
        const time = Number.isNaN(instant.getTime()) ? "Time unavailable" : instant.toLocaleString("en-US", { timeZone: "America/Chicago", month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit" });
        const text = entry.kind === "reading" ? `${entry.source === "current" ? "Current saved record" : "Log entry"}: ${poolSnapshotDescription(entry.snapshot || {}, entry.previous_snapshot || {})}`
          : entry.kind === "close" ? `Pool closed${entry.reason ? `: ${entry.reason}` : ""}`
          : entry.kind === "open" ? `Pool opened${entry.reason ? `: ${entry.reason}` : ""}`
          : `Manual hold cleared${entry.reason ? `: ${entry.reason}` : ""}`;
        return <div key={`${entry.kind}:${entry.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-1 border-b border-slate-800 px-2 py-1 text-xs last:border-0 sm:grid-cols-[8rem_7rem_minmax(0,1fr)]">
          <time className="text-slate-400" dateTime={entry.recorded_at}>{time}</time>
          <span className="truncate font-semibold text-sky-200">{entry.actor_name || "Staff"}</span>
          <span className="col-span-2 whitespace-pre-wrap break-words text-slate-200 sm:col-span-1">{text}</span>
        </div>;
      })}
    </div> : <p className="mt-1 text-xs text-slate-400">No activity recorded for this date.</p>}
  </section>;
}
