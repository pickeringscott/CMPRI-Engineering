"use client";

import { useEffect, useState } from "react";

/** Shared desktop artwork; never mount or download the animation on phones. */
export default function ThanksgivingBackground() {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  if (!desktop) return null;
  return (
    <iframe
      title="Thanksgiving desktop background with pause animation control"
      src="/backgrounds/thanksgiving-animated/index.html"
      sandbox="allow-scripts"
      className="absolute inset-0 z-0 h-full w-full border-0"
    />
  );
}
