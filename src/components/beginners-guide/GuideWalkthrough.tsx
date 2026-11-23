"use client";

import Image from "next/image";
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import styles from "./GuideWalkthrough.module.css";

type GuideStep = {
  title: string;
  text: string;
  directions?: [label: string, detail: string][];
  result?: string;
  hint?: string;
  context?: string;
  sourceUrl?: string;
  screenshot?: { src: string; width: number; height: number; alt: string };
  target?: [number, number, number, number];
  fitToWidth?: boolean;
};

export type GuideAction = GuideStep & { mobile?: Partial<GuideStep> };

type Props = {
  title: string;
  purpose?: string;
  when?: string;
  action: GuideAction;
  onTry?: () => void;
};

const COMPACT_GUIDE = "(max-width: 700px), (hover: none) and (pointer: coarse)";

function subscribeToDevice(change: () => void) {
  const media = window.matchMedia(COMPACT_GUIDE);
  media.addEventListener("change", change);
  return () => media.removeEventListener("change", change);
}

function readCompactDevice() {
  return window.matchMedia(COMPACT_GUIDE).matches;
}

function readServerDevice() {
  return false;
}

function highlightPosition(screenshot: GuideAction["screenshot"], target: GuideAction["target"]) {
  if (!screenshot || !target) return;
  const [x, y, width, height] = target;
  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  return {
    left: percent(x, screenshot.width),
    top: percent(y, screenshot.height),
    width: percent(width, screenshot.width),
    height: percent(height, screenshot.height),
  };
}

export default function GuideWalkthrough({ title, purpose, when, action, onTry }: Props) {
  const { t } = useUiLanguage();
  const headingId = useId();
  const actionId = useId();
  const viewportId = useId();
  const walkthroughRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const aboutRef = useRef<HTMLDetailsElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLSpanElement>(null);
  const arrowRef = useRef<HTMLSpanElement>(null);
  const [sizePreference, setSizePreference] = useState<boolean>();
  const compact = useSyncExternalStore(subscribeToDevice, readCompactDevice, readServerDevice);
  const step = compact && action.mobile ? { ...action, ...action.mobile } : action;
  const { screenshot, target } = step;
  const position = highlightPosition(screenshot, target);
  // Fitting a wide strip makes its controls too small to read.
  const isWideStrip = Boolean(target && screenshot && screenshot.width >= screenshot.height * 5);
  const actualSize = sizePreference ?? (isWideStrip && !step.fitToWidth);
  const arrowBelow = target && screenshot && target[1] < (screenshot.height - target[3]) / 2;
  const hotspotLabel = t("Try {step} in the sample", "Practicar {step} en el ejemplo", {
    step: t(step.title),
  });
  const about = (purpose || when) && <dl className={styles.about}>
    {purpose && <div>
      <dt>{t("What it does", "Qué hace")}</dt>
      <dd>{t(purpose)}</dd>
    </div>}
    {when && <div>
      <dt>{t("When to use it", "Cuándo usarlo")}</dt>
      <dd>{t(when)}</dd>
    </div>}
  </dl>;

  useLayoutEffect(() => {
    const walkthrough = walkthroughRef.current;
    if (walkthrough) walkthrough.scrollTop = 0;
    if (aboutRef.current) aboutRef.current.open = false;
  }, [action, compact]);

  useLayoutEffect(() => {
    const walkthrough = walkthroughRef.current;
    const header = headerRef.current;
    const viewport = viewportRef.current;
    if (!walkthrough || !header || !viewport) return;

    function reveal(walkthrough: HTMLDivElement, header: HTMLDivElement, viewport: HTMLDivElement) {
      const stacked = getComputedStyle(walkthrough).display === "block";
      const pinned = stacked && !aboutRef.current?.open && walkthrough.clientHeight - header.offsetHeight >= 56;
      walkthrough.toggleAttribute("data-pin-instruction", pinned);
      if (aboutRef.current?.open) return;

      const highlight = highlightRef.current;
      if (!highlight) {
        viewport.scrollTo(0, 0);
        return;
      }
      const box = highlight.getBoundingClientRect();
      const arrow = arrowRef.current?.getBoundingClientRect();
      const top = Math.min(box.top, arrow?.top ?? box.top);
      const bottom = Math.max(box.bottom, arrow?.bottom ?? box.bottom);
      const sampleLeft = viewport.getBoundingClientRect().left;
      if (box.left < sampleLeft || box.right > sampleLeft + viewport.clientWidth) {
        viewport.scrollLeft += box.left - sampleLeft + (box.width - viewport.clientWidth) / 2;
      }

      const vertical = stacked ? walkthrough : viewport;
      const verticalTop = vertical.getBoundingClientRect().top;
      const visibleTop = verticalTop + (pinned ? header.offsetHeight : 0);
      const visibleBottom = verticalTop + vertical.clientHeight;
      if (top < visibleTop || bottom > visibleBottom) {
        vertical.scrollTop += top - visibleTop + (bottom - top - (visibleBottom - visibleTop)) / 2;
      }
    }

    const update = () => reveal(walkthrough, header, viewport);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(walkthrough);
    observer.observe(header);
    return () => observer.disconnect();
  }, [action, actualSize, compact]);

  return (
    <div className={`${styles.walkthrough}${screenshot ? ` ${styles.withExample}` : ""}`} ref={walkthroughRef}
      data-sample-action={onTry && position ? "" : undefined}>
      <div className={styles.header} ref={headerRef}>
        <section className={styles.explanation} aria-labelledby={headingId}>
          <h2 id={headingId}>{t(title)}</h2>
          {about && <div className={styles.desktopAbout}>{about}</div>}
          <div className={styles.instruction}>
            {step.context && <p className={styles.context}>{t(step.context)}</p>}
            <div aria-live="polite" aria-atomic="true">
              <h3 id={actionId}>{t(step.title)}</h3>
              <p>{t(step.text)}</p>
              {!!step.directions?.length && <ol className={styles.directions} aria-label={t("Step-by-step directions", "Instrucciones paso a paso")}>
                {step.directions.map(([label, detail]) => <li key={label}>
                  <strong>{t(label)}</strong> · {t(detail)}
                </li>)}
              </ol>}
              {step.result && <p className={styles.result}>
                <strong>{t("What you’ll see", "Lo que verás")}</strong>
                <span>{t(step.result)}</span>
              </p>}
            </div>
            {step.hint && <p className={styles.hint}>{t(step.hint)}</p>}
            {(onTry || step.sourceUrl) && <div className={styles.actionLinks}>
              {onTry && <button type="button" className={styles.tryButton} aria-describedby={actionId} onClick={onTry}>
                {t("Try in sample", "Practicar en el ejemplo")}
              </button>}
              {step.sourceUrl && <a href={step.sourceUrl} target="_blank" rel="noreferrer"
                aria-label={t("Open reference in a new tab", "Abrir referencia en una pestaña nueva")}>
                {t("Open reference", "Abrir referencia")}
              </a>}
            </div>}
          </div>
          {about && <details className={styles.mobileAbout} ref={aboutRef} onToggle={event => {
            if (event.currentTarget.open && walkthroughRef.current) walkthroughRef.current.scrollTop = 0;
          }}>
            <summary>{t("About this tool", "Acerca de esta herramienta")}</summary>
            {about}
          </details>}
        </section>
        {screenshot && <div className={styles.exampleToolbar}>
          <span className={styles.exampleLabel}>{t("Sample screen", "Pantalla de ejemplo")}</span>
          <div className={styles.viewModes} role="group" aria-label={t("Sample display size", "Tamaño del ejemplo")}>
            <button type="button" aria-pressed={!actualSize} onClick={() => setSizePreference(false)}>
              {t("Fit to width", "Ajustar al ancho")}
            </button>
            <button type="button" aria-pressed={actualSize} onClick={() => setSizePreference(true)}>
              {t("Actual size", "Tamaño real")}
            </button>
          </div>
          {onTry && position && <button type="button" className={styles.compactButton} aria-describedby={actionId} onClick={onTry}>
            {t("Try control", "Probar control")}
          </button>}
          <button type="button" className={styles.compactButton} aria-controls={viewportId} onClick={() => setSizePreference(!actualSize)}>
            {actualSize ? t("Fit width", "Ajustar al ancho") : t("Actual size", "Tamaño real")}
          </button>
        </div>}
      </div>
      {screenshot && <div className={styles.exampleViewport} id={viewportId} ref={viewportRef} role="region" tabIndex={0}
        aria-label={t("Scrollable sample screen", "Pantalla de ejemplo desplazable")}>
        <div className={`${styles.capture}${actualSize ? "" : ` ${styles.fit}`}`}
          data-short-capture={screenshot.height < 85 ? "" : undefined}
          style={{ "--capture-width": `${screenshot.width}px` } as CSSProperties}>
          <Image key={screenshot.src} src={screenshot.src} width={screenshot.width} height={screenshot.height} alt={t(screenshot.alt)} unoptimized />
          {position && <span className={styles.highlight} ref={highlightRef} style={position}>
            <span className={arrowBelow ? styles.arrowBelow : styles.arrowAbove} ref={arrowRef} aria-hidden="true" />
            {onTry && <button type="button" className={styles.hotspot} aria-label={hotspotLabel} onClick={onTry} />}
          </span>}
        </div>
      </div>}
    </div>
  );
}
