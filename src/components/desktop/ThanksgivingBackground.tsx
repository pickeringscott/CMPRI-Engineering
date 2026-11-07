"use client";

import { useEffect } from "react";
import assets from "@/lib/ui/thanksgiving-assets.json";
import { ensureThanksgivingCache } from "@/lib/ui/thanksgiving-cache";

/** Fixed viewport artwork shared by the approved desktop and mobile layouts. */
export default function ThanksgivingBackground() {
  useEffect(() => {
    void ensureThanksgivingCache();
  }, []);

  return (
    // Clip to the desktop while keeping the artwork's viewport independent
    // of header groups wrapping, collapsing, or moving during rearrangement.
    <div className="absolute inset-0 z-0" style={{ clipPath: "inset(0)" }}>
      <iframe
        title="Thanksgiving desktop background with pause animation control"
        src={assets.entry}
        // Same-origin access lets the trusted static artwork use the site's asset cache.
        sandbox="allow-scripts allow-same-origin"
        className="fixed inset-0 h-full w-full border-0"
      />
    </div>
  );
}
