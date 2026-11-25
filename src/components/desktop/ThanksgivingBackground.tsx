"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import assets from "@/lib/ui/thanksgiving-assets.json";
import { ensureThanksgivingCache } from "@/lib/ui/thanksgiving-cache";
import { SeasonalAnimationControl } from "./seasonal-animation-controls";

const subscribe = () => () => {};

function hideArtworkControl(frame: HTMLIFrameElement | null) {
  const toggle = frame?.contentDocument?.getElementById("toggle");
  if (toggle) toggle.hidden = true;
}

/** Fixed viewport artwork shared by the approved desktop and mobile layouts. */
export default function ThanksgivingBackground() {
  const pathname = usePathname();
  // Rewritten routes can have a different pathname during server rendering.
  const visible = useSyncExternalStore(subscribe,
    () => pathname === "/" || pathname === "/engineering" || pathname === "/front-desk", () => false);
  const frame = useRef<HTMLIFrameElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    void ensureThanksgivingCache();
    hideArtworkControl(frame.current);
  }, []);

  return (
    <>
    <div className="cmpri-persistent-artwork" hidden={!visible}>
      <iframe
        ref={frame}
        title="Thanksgiving desktop background with pause animation control"
        src={assets.entry}
        // Same-origin access lets the trusted static artwork use the site's asset cache.
        sandbox="allow-scripts allow-same-origin"
        className="fixed inset-0 h-full w-full border-0"
        onLoad={event => hideArtworkControl(event.currentTarget)}
      />
    </div>
      <SeasonalAnimationControl>
        <button hidden={!visible} className="cmpri-animation-control" type="button" aria-label={paused ? "Resume animation" : "Pause animation"} aria-pressed={paused} onClick={() => {
          const toggle = frame.current?.contentDocument?.getElementById("toggle");
          if (toggle) { toggle.click(); setPaused(toggle.getAttribute("aria-pressed") === "true"); }
        }}>{paused ? "▶" : "Ⅱ"}</button>
      </SeasonalAnimationControl>
    </>
  );
}
