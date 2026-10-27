"use client";

import { useEffect, useState } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import ShutoffGuide from "./ShutoffGuide";

export default function ShutoffGuideViewer() {
  const [images, setImages] = useState<Record<"water" | "gas" | "risers", { src: string; width: number; height: number }> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    void (async () => {
      const headers = await authorizationHeaders();
      const entries = await Promise.all((["water", "gas", "risers"] as const).map(async (name) => {
        const response = await fetch(`/api/guides/shutoff/${name}`, { headers, cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("The guide could not be loaded. Close it and try again.");
        const blob = await response.blob();
        if (controller.signal.aborted) throw new Error("Closed");
        const src = URL.createObjectURL(blob);
        urls.push(src);
        return [name, { src, width: 1426, height: 1103 }] as const;
      }));
      if (!controller.signal.aborted) setImages(Object.fromEntries(entries) as NonNullable<typeof images>);
    })().catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "The guide could not be loaded.");
        controller.abort();
        urls.forEach((url) => URL.revokeObjectURL(url));
      }
    });
    return () => { controller.abort(); urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, []);
  return <div className="min-h-0 flex-1 overflow-auto bg-slate-100">
    {images ? <ShutoffGuide images={images} /> : <p className="p-4 text-slate-900" role={error ? "alert" : "status"}>{error || "Loading color references…"}</p>}
  </div>;
}
