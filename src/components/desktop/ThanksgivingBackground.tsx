"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import assets from "@/lib/ui/thanksgiving-assets.json";
import { ensureThanksgivingCache } from "@/lib/ui/thanksgiving-cache";

/** Fixed viewport artwork shared by the approved desktop and mobile layouts. */
export default function ThanksgivingBackground() {
  const pathname = usePathname();
  const visible = pathname === "/" || pathname === "/engineering";
  const frame = useRef<HTMLIFrameElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    void ensureThanksgivingCache();
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
      />
    </div>
      <button hidden={!visible} className="cmpri-animation-control" type="button" aria-label={paused ? "Resume animation" : "Pause animation"} aria-pressed={paused} onClick={() => {
        const toggle = frame.current?.contentDocument?.getElementById("toggle");
        if (toggle) { toggle.click(); setPaused(toggle.getAttribute("aria-pressed") === "true"); }
      }}>{paused ? "▶" : "Ⅱ"}</button>
    </>
  );
}
