"use client";

import Image from "next/image";
import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import styles from "./GuideWalkthrough.module.css";

export type GuideAction = {
  title: string;
  text: string;
  hint?: string;
  context?: string;
  sourceUrl?: string;
  screenshot?: { src: string; width: number; height: number; alt: string };
  target?: [number, number, number, number];
};

type Props = {
  title: string;
  purpose?: string;
  when?: string;
  action: GuideAction;
  onTry?: () => void;
};

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
  const [actualSize, setActualSize] = useState(false);
  const { screenshot, target } = action;
  const position = highlightPosition(screenshot, target);
  const arrowBelow = target && screenshot && target[1] < (screenshot.height - target[3]) / 2;
  const hotspotLabel = t("Try {step} in the sample", "Practicar {step} en el ejemplo", {
    step: t(action.title),
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
  }, [action]);

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
  }, [action, actualSize]);

  return (
    <div className={`${styles.walkthrough}${screenshot ? ` ${styles.withExample}` : ""}`} ref={walkthroughRef}
      data-sample-action={onTry && position ? "" : undefined}>
      <div className={styles.header} ref={headerRef}>
        <section className={styles.explanation} aria-labelledby={headingId}>
          <h2 id={headingId}>{t(title)}</h2>
          {about && <div className={styles.desktopAbout}>{about}</div>}
          <div className={styles.instruction}>
            {action.context && <p className={styles.context}>{t(action.context)}</p>}
            <div aria-live="polite" aria-atomic="true">
              <h3 id={actionId}>{t(action.title)}</h3>
              <p>{t(action.text)}</p>
            </div>
            {action.hint && <p className={styles.hint}>{t(action.hint)}</p>}
            {(onTry || action.sourceUrl) && <div className={styles.actionLinks}>
              {onTry && <button type="button" className={styles.tryButton} aria-describedby={actionId} onClick={onTry}>
                {t("Try in sample", "Practicar en el ejemplo")}
              </button>}
              {action.sourceUrl && <a href={action.sourceUrl} target="_blank" rel="noreferrer"
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
            <button type="button" aria-pressed={!actualSize} onClick={() => setActualSize(false)}>
              {t("Fit to width", "Ajustar al ancho")}
            </button>
            <button type="button" aria-pressed={actualSize} onClick={() => setActualSize(true)}>
              {t("Actual size", "Tamaño real")}
            </button>
          </div>
          {onTry && position && <button type="button" className={styles.compactButton} aria-describedby={actionId} onClick={onTry}>
            {t("Try control", "Probar control")}
          </button>}
          <button type="button" className={styles.compactButton} aria-controls={viewportId} onClick={() => setActualSize(value => !value)}>
            {actualSize ? t("Fit width", "Ajustar al ancho") : t("Actual size", "Tamaño real")}
          </button>
        </div>}
      </div>
      {screenshot && <div className={styles.exampleViewport} id={viewportId} ref={viewportRef} role="region" tabIndex={0}
        aria-label={t("Scrollable sample screen", "Pantalla de ejemplo desplazable")}>
        <div className={`${styles.capture}${actualSize ? "" : ` ${styles.fit}`}`}
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
