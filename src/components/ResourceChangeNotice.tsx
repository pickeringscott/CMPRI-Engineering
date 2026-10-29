"use client";
import { useEffect, useState } from "react";
import { subscribeResource } from "@/lib/events/browser";
import type { Resource } from "@/lib/events/resources";
/** Editing surfaces retain drafts. A committed remote revision offers an explicit reload. */
export default function ResourceChangeNotice({ resource }: { resource: Resource }) {
  const [changed, setChanged] = useState(false);
  useEffect(() => subscribeResource(resource, reason => { if (reason === "change") setChanged(true); }), [resource]);
  return changed ? <div role="status" className="border border-amber-500 bg-slate-950 p-2 text-sm text-white">
    Saved data changed. Your open draft is preserved. Finish saving before <button className="underline" onClick={() => window.location.reload()}>reloading saved data</button>.
  </div> : null;
}
