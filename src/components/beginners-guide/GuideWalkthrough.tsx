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

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const highlight = highlightRef.current;
    if (!highlight) {
      viewport.scrollTo(0, 0);
      return;
    }
    const area = viewport.getBoundingClientRect();
    const box = highlight.getBoundingClientRect();
    const arrow = arrowRef.current?.getBoundingClientRect();
    const top = Math.min(box.top, arrow?.top ?? box.top);
    const bottom = Math.max(box.bottom, arrow?.bottom ?? box.bottom);
    const horizontal = box.left < area.left || box.right > area.left + viewport.clientWidth;
    const vertical = top < area.top || bottom > area.top + viewport.clientHeight;
    if (horizontal || vertical) {
      viewport.scrollTo({
        left: horizontal ? viewport.scrollLeft + box.left - area.left + (box.width - viewport.clientWidth) / 2 : viewport.scrollLeft,
        top: vertical ? viewport.scrollTop + top - area.top + (bottom - top - viewport.clientHeight) / 2 : viewport.scrollTop,
        behavior: "instant",
      });
    }
  }, [screenshot?.src, target, actualSize]);

  return (
    <div className={`${styles.walkthrough}${screenshot ? ` ${styles.withExample}` : ""}`}>
      {screenshot && <div className={styles.example}>
        <div className={styles.exampleToolbar}>
          <span>{t("Sample screen", "Pantalla de ejemplo")}</span>
          <div className={styles.viewModes} role="group" aria-label={t("Sample display size", "Tamaño del ejemplo")}>
            <button type="button" aria-pressed={!actualSize} onClick={() => setActualSize(false)}>
              {t("Fit to width", "Ajustar al ancho")}
            </button>
            <button type="button" aria-pressed={actualSize} onClick={() => setActualSize(true)}>
              {t("Actual size", "Tamaño real")}
            </button>
          </div>
        </div>
        <div className={styles.exampleViewport} ref={viewportRef} role="region" tabIndex={0}
          aria-label={t("Scrollable sample screen", "Pantalla de ejemplo desplazable")}>
          <div className={`${styles.capture}${actualSize ? "" : ` ${styles.fit}`}`}
            style={{ "--capture-width": `${screenshot.width}px` } as CSSProperties}>
            <Image key={screenshot.src} src={screenshot.src} width={screenshot.width} height={screenshot.height} alt={t(screenshot.alt)} unoptimized />
            {position && <span className={styles.highlight} ref={highlightRef} style={position}>
              <span className={arrowBelow ? styles.arrowBelow : styles.arrowAbove} ref={arrowRef} aria-hidden="true" />
              {onTry && <button type="button" className={styles.hotspot} aria-label={hotspotLabel} onClick={onTry} />}
            </span>}
          </div>
        </div>
      </div>}

      <section className={styles.explanation} aria-labelledby={headingId}>
        <h2 id={headingId}>{t(title)}</h2>
        {(purpose || when) && <dl className={styles.about}>
          {purpose && <div>
            <dt>{t("What it does", "Qué hace")}</dt>
            <dd>{t(purpose)}</dd>
          </div>}
          {when && <div>
            <dt>{t("When to use it", "Cuándo usarlo")}</dt>
            <dd>{t(when)}</dd>
          </div>}
        </dl>}
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
      </section>
    </div>
  );
}
