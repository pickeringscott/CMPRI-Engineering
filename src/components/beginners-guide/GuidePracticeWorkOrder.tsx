"use client";

import { useState } from "react";
import { practiceWorkOrder, workOrderPracticeId } from "./ask-cmpri-practice";

const checks = [
  "Review the model and reported symptom.",
  "Verify the displayed controls and record what responds.",
  "Keep the equipment out of guest use and record the next action.",
];

export default function GuidePracticeWorkOrder({ id }: { id: string }) {
  const order = practiceWorkOrder(id);
  const [tried, setTried] = useState<Record<number, { outcome: string; observation: string }>>({});
  const [saved, setSaved] = useState<string[]>([]);
  if (!order) return null;
  return <section aria-label="Sample Work Order" className="mx-auto max-w-3xl space-y-3 p-4 text-sm">
    <h3 className="text-lg font-semibold">Work Order WO#{order.number} · Room {order.room}</h3>
    <p>Training record. Changes stay in this example.</p>
    <section><h4 className="font-semibold">Reported issue</h4><p>{order.issue}</p></section>
    <dl className="grid grid-cols-2 gap-x-3">
      <dt>Status</dt><dd>{order.status}</dd>
      <dt>Priority</dt><dd>{order.priority}</dd>
      <dt>Assigned to</dt><dd>{order.assignee}</dd>
    </dl>
    <details className="rounded border p-2">
      <summary className="cursor-pointer font-semibold">Notes &amp; Ticket History</summary>
      <p>{order.repair}</p>
      {!!saved.length && <><p className="font-semibold">Combined troubleshooting note</p><ul className="list-disc pl-6">{saved.map(note => <li key={note}>{note}</li>)}</ul></>}
    </details>
    {id === workOrderPracticeId && <details className="rounded border p-2">
      <summary className="cursor-pointer font-semibold">Suggested Troubleshooting</summary>
      <p className="my-1">Selected asset · GE JES1072SHSS · MW-214</p>
      <a className="underline" href="https://products.geappliances.com/appliance/gea-specs/JES1072SHSS/support" target="_blank" rel="noreferrer">Source · GE Appliances</a>
      <ol className="my-2 list-decimal space-y-2 pl-6">{checks.map((label, index) => {
        const attempt = tried[index];
        return <li key={label}>
          <p>{label}</p>
          <label><input type="checkbox" aria-label={`Tried: ${label}`} checked={!!attempt} onChange={event => {
            const checked = event.currentTarget.checked;
            setTried(current => {
              if (checked) return { ...current, [index]: { outcome: "", observation: "" } };
              const next = { ...current };
              delete next[index];
              return next;
            });
          }} /> Tried</label>
          {attempt && <div className="flex flex-wrap items-center gap-2">
            <label>Outcome <select aria-label={`Outcome: ${label}`} value={attempt.outcome} onChange={event => setTried({ ...tried, [index]: { ...attempt, outcome: event.target.value } })}>
              <option value="">Choose outcome</option><option>Resolved</option><option>No change</option><option>Issue confirmed</option><option>Follow-up needed</option>
            </select></label>
            <input aria-label={`Observation: ${label}`} placeholder="Add observation" maxLength={140} value={attempt.observation} onChange={event => setTried({ ...tried, [index]: { ...attempt, observation: event.target.value } })} />
          </div>}
        </li>;
      })}</ol>
      <button type="button" className="rounded border px-2 py-1" disabled={!Object.keys(tried).length} onClick={() => setSaved(Object.entries(tried).map(([index, attempt]) => [checks[Number(index)], attempt.outcome, attempt.observation.trim()].filter(Boolean).join(" · ")))}>Save sample note</button>
      {!!saved.length && <p role="status">Combined work-order note saved in this example.</p>}
    </details>}
  </section>;
}
