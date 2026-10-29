"use client";
import { useEffect, useState } from "react";
import { subscribeResource, recoverResourceEvents } from "@/lib/events/browser";
/** Access changes discard the entire document's private state before another display. */
export default function EventConnection() {
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const failed = () => setUnavailable(true), ready = () => setUnavailable(false);
    window.addEventListener("cmpri:events-unavailable", failed);
    window.addEventListener("cmpri:events-ready", ready);
    return () => { window.removeEventListener("cmpri:events-unavailable", failed); window.removeEventListener("cmpri:events-ready", ready); };
  }, []);
  useEffect(() => {
    let established = false;
    return subscribeResource("access", reason => {
      if (reason === "initial") established = true;
      else if (reason === "change" || established) window.location.reload();
    });
  }, []);
  return unavailable ? <div role="alert" className="border border-amber-500 bg-slate-950 p-2 text-white">Live updates are unavailable. <button className="underline" onClick={recoverResourceEvents}>Retry live updates</button></div> : null;
}
