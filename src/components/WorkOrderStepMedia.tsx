"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createClient, getValidSession } from "@/lib/supabase/client";
import type { TroubleshootingStepMedia } from "@/lib/manual-knowledge";
import WorkOrderDiagramViewer from "@/components/WorkOrderDiagramViewer";
import { themeSourceDiagramBlob } from "@/lib/work-orders/diagram-theme";
import { sourceSemantics } from "@/lib/work-orders/source-semantics";
import type { SourceSemantics } from "@/lib/work-orders/source-semantics";

const desktopQuery = "(min-width: 768px)";
function subscribeDesktop(changed: () => void) {
  const query = window.matchMedia(desktopQuery);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
}
function desktopSnapshot() { return typeof window !== "undefined" && window.matchMedia(desktopQuery).matches; }

type Props = {
  media: TroubleshootingStepMedia[];
  assetId: string;
  sourceSha256: string;
  userId: string;
  contextIdentity: string;
};

/** Only source-bound media supplied by the authorized guide can be requested. */
export default function WorkOrderStepMedia(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [paletteVersion, setPaletteVersion] = useState(0);
  const hasMedia = props.media.length > 0;
  useEffect(() => {
    if (!host.current || typeof MutationObserver === "undefined") return;
    const signature = () => { const value = getComputedStyle(host.current!); return value.backgroundColor + "/" + value.color; };
    let previous = signature();
    const changed = () => { const next = signature(); if (next !== previous) { previous = next; setPaletteVersion(value => value + 1); } };
    const observer = new MutationObserver(changed);
    for (let ancestor: HTMLElement | null = host.current.parentElement; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor, { attributes: true, attributeFilter: ["style", "class", "data-theme", "data-cmpri-modal-theme"] });
    window.addEventListener("cmpri-palette-change", changed);
    return () => { observer.disconnect(); window.removeEventListener("cmpri-palette-change", changed); };
  }, [hasMedia]);
  const scope = JSON.stringify([props.assetId, props.sourceSha256, props.userId, props.contextIdentity, props.media.map(item => item.id), paletteVersion]);
  return props.media.length ? <div ref={host} data-source-media-surface="true" style={{ backgroundColor: "var(--cmpri-modal-surface,#191b24)", color: "var(--cmpri-modal-text,#f0f1f6)" }}><StepMediaView key={scope} {...props} host={host} /></div> : null;
}

function StepMediaView({ media, assetId, sourceSha256, userId, host }: Props & { host: React.RefObject<HTMLDivElement | null> }) {
  const desktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, () => false);
  const [images, setImages] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ imageUrl: string; title: string; semantics: SourceSemantics | null } | null>(null);
  const [adapted, setAdapted] = useState<Record<string, boolean>>({});
  const [authorized, setAuthorized] = useState(true);
  const alive = useRef(true);
  const allowed = useRef(true);
  const urls = useRef(new Map<string, string>());
  const pending = useRef(new Map<string, Promise<string>>());
  const controllers = useRef(new Set<AbortController>());
  const openGeneration = useRef(0);

  const release = useCallback(() => {
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    for (const url of urls.current.values()) URL.revokeObjectURL(url);
    urls.current.clear();
    pending.current.clear();
  }, []);

  useEffect(() => {
    alive.current = true;
    const { data: { subscription } } = createClient().auth.onAuthStateChange((_event, auth) => {
      if (auth?.user.id === userId) return;
      allowed.current = false;
      release();
      setAuthorized(false);
      setImages({});
      setSelected(null);
    });
    return () => { alive.current = false; release(); subscription.unsubscribe(); };
  }, [release, userId]);

  const sourceUrl = useCallback((item: TroubleshootingStepMedia) => {
    const query = new URLSearchParams({ source: "asset-upload", assetId, imageId: item.id, sha256: sourceSha256 });
    return `/api/maintenance-reference?${query}`;
  }, [assetId, sourceSha256]);

  const load = useCallback((item: TroubleshootingStepMedia): Promise<string> => {
    const existing = urls.current.get(item.id);
    if (existing) return Promise.resolve(existing);
    const running = pending.current.get(item.id);
    if (running) return running;
    const controller = new AbortController();
    controllers.current.add(controller);
    const current = () => alive.current && allowed.current && !controller.signal.aborted;
    const work: Promise<string> = (async () => {
      const auth = await getValidSession();
      if (!current() || !auth?.access_token || auth.user.id !== userId) throw new Error("Sign in again to view this image.");
      const response = await fetch(sourceUrl(item), { headers: { Authorization: `Bearer ${auth.access_token}` }, cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "The image from the uploaded document could not be opened.");
      }
      if (response.headers.get("content-type")?.split(";")[0] !== "image/png") throw new Error("The uploaded document did not return a supported image.");
      const blob = await response.blob();
      if (!blob.size || blob.size > 12 * 1024 * 1024) throw new Error("The source image is unavailable or too large to display.");
      const authAfterRead = await getValidSession();
      if (!current() || authAfterRead?.user.id !== userId) throw new Error("Your account changed before this image was opened.");
      const display = await themeSourceDiagramBlob(blob, host.current, item.stepLabel + "\n" + item.caption);
      if (!current()) throw new Error("This image is no longer current.");
      const url = URL.createObjectURL(display.blob);
      urls.current.set(item.id, url);
      setAdapted(previous => ({ ...previous, [item.id]: display.adapted }));
      setImages(previous => ({ ...previous, [item.id]: url }));
      setErrors(previous => { const next = { ...previous }; delete next[item.id]; return next; });
      return url;
    })().finally(() => { if (pending.current.get(item.id) === work) pending.current.delete(item.id); controllers.current.delete(controller); });
    pending.current.set(item.id, work);
    return work;
  }, [host, sourceUrl, userId]);

  useEffect(() => {
    if (!desktop || !authorized) return;
    queueMicrotask(() => {
      if (!alive.current || !allowed.current) return;
      for (const item of media) void load(item).catch(failure => {
        if (alive.current && allowed.current) setErrors(previous => ({ ...previous, [item.id]: failure instanceof Error ? failure.message : "This source image could not be loaded." }));
      });
    });
  }, [authorized, desktop, load, media]);

  async function open(item: TroubleshootingStepMedia) {
    const generation = ++openGeneration.current;
    setOpening(item.id);
    try {
      const url = await load(item);
      if (alive.current && allowed.current && generation === openGeneration.current) setSelected({ imageUrl: url, title: item.caption || "Image/diagram from the uploaded manual", semantics: sourceSemantics(item.stepLabel, item.caption) });
    } catch (failure) {
      if (alive.current && allowed.current) setErrors(previous => ({ ...previous, [item.id]: failure instanceof Error ? failure.message : "This source image could not be opened." }));
    } finally { if (alive.current && generation === openGeneration.current) setOpening(null); }
  }

  if (!authorized) return null;
  return <section aria-label="Step images and diagrams" className="space-y-0">
    {media.map(item => { const semantics = sourceSemantics(item.stepLabel, item.caption); return <div key={item.id} className="leading-tight" style={semantics ? { borderInlineStart: `2px solid ${semantics.color}` } : undefined}>
      {semantics && <span className="text-[10px] leading-tight" style={{ color: semantics.color }}>{semantics.label}</span>}
      {desktop
        ? images[item.id] ? <a href={sourceUrl(item)} aria-label={`Open image/diagram: ${item.caption || "uploaded manual illustration"}`} onClick={event => { event.preventDefault(); event.stopPropagation(); void open(item); }} className="block w-fit max-w-full">
            {/* Source pixels are held locally; flat neutral artwork alone follows the host palette. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img data-diagram-adapted={adapted[item.id] ? "true" : "false"} src={images[item.id]} alt={item.caption || "Image/diagram from the uploaded manual"} width={item.width} height={item.height} className="max-h-64 w-auto max-w-full object-contain" />
          </a> : <p className="text-[10px] leading-tight text-slate-400">{errors[item.id] ? "Image unavailable" : "Loading image…"}</p>
        : <a href={sourceUrl(item)} aria-disabled={opening === item.id} onClick={event => { event.preventDefault(); event.stopPropagation(); if (opening !== item.id) void open(item); }} className="text-[11px] underline" style={{ color: semantics?.color || "var(--cmpri-modal-text,#f0f1f6)" }}>{opening === item.id ? "Opening image…" : "Open image/diagram"}</a>}
      {errors[item.id] && <p role="status" className="text-[10px] leading-tight text-amber-200">{errors[item.id]}</p>}
    </div>; })}
    {selected && <WorkOrderDiagramViewer imageUrl={selected.imageUrl} title={selected.title} semantics={selected.semantics} onClose={() => { openGeneration.current++; setSelected(null); setOpening(null); }} />}
  </section>;
}
