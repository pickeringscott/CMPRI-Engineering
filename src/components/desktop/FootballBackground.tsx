"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import assets from "@/lib/ui/football-assets.json";
import { ensureFootballCache } from "@/lib/ui/football-cache";

type ArtworkState = { paused: boolean; ready: boolean };
type ArtworkControl =
  | { action: "suspend"; suspended: boolean }
  | { action: "toggle" }
  | { action: "request-state" };

/** One persistent artwork instance, shared by sign-in and the desktop. */
export default function FootballBackground() {
  const pathname = usePathname();
  const visible = pathname === "/" || pathname === "/engineering";
  const frame = useRef<HTMLIFrameElement>(null);
  const [artwork, setArtwork] = useState<ArtworkState>({ paused: true, ready: false });
  const sendControl = useCallback((control: ArtworkControl) => {
    frame.current?.contentWindow?.postMessage(
      { type: "cmpri-football-control", ...control },
      window.location.origin,
    );
  }, []);
  const syncSuspension = useCallback(() => {
    sendControl({ action: "suspend", suspended: !visible || document.hidden });
  }, [sendControl, visible]);
  const handleLoad = useCallback(() => {
    syncSuspension();
    sendControl({ action: "request-state" });
  }, [sendControl, syncSuspension]);

  useEffect(() => {
    void ensureFootballCache();
  }, []);

  useEffect(() => {
    const receiveState = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if (!event.data || typeof event.data !== "object") return;
      const data = event.data as Record<string, unknown>;
      if (data.type !== "cmpri-football-state" || typeof data.paused !== "boolean" || typeof data.ready !== "boolean") return;
      const next = { paused: data.paused, ready: data.ready };
      setArtwork((current) => current.paused === next.paused && current.ready === next.ready ? current : next);
    };
    window.addEventListener("message", receiveState);
    return () => window.removeEventListener("message", receiveState);
  }, []);

  useEffect(() => {
    syncSuspension();
    document.addEventListener("visibilitychange", syncSuspension);
    return () => document.removeEventListener("visibilitychange", syncSuspension);
  }, [syncSuspension]);

  return (
    <>
      <div className="cmpri-persistent-artwork cmpri-football-artwork" hidden={!visible}>
        <iframe
          ref={frame}
          title="Illinois versus Iowa football background"
          src={`${assets.entry}?theme=1`}
          sandbox="allow-scripts allow-same-origin"
          className="fixed inset-0 h-full w-full border-0"
          onLoad={handleLoad}
        />
      </div>
      <button
        hidden={!visible}
        disabled={!artwork.ready}
        className="cmpri-animation-control cmpri-football-animation-control"
        type="button"
        aria-label={artwork.paused ? "Resume football animation" : "Pause football animation"}
        aria-pressed={artwork.paused}
        onClick={() => sendControl({ action: "toggle" })}
      >
        {!artwork.ready ? "Loading" : artwork.paused ? "Resume" : "Pause"}
      </button>
    </>
  );
}
