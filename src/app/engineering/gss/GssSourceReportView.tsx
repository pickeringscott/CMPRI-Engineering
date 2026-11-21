"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import styles from "./GssScorecard.module.css";
// Native picture keeps report data URLs in the browser without an image-proxy request.

export type SourceReport = {
  date: string;
  images: { period: "First ranking" | "Second ranking"; dataUrl: string }[];
};
export type SourceReportState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; report: SourceReport };

export function formatReportDate(date: string, locale = "en-US") {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function parseSourceReport(value: unknown): SourceReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Record<string, unknown>;
  if (typeof report.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(report.date)) return null;
  const date = new Date(`${report.date}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== report.date) return null;
  if (!Array.isArray(report.images) || report.images.length !== 2) return null;
  const images = report.images as Record<string, unknown>[];
  if (!images.every(image => image && (image.period === "First ranking" || image.period === "Second ranking") && typeof image.dataUrl === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(image.dataUrl))) return null;
  if (new Set(images.map(image => image.period)).size !== 2) return null;
  return { date: report.date, images: images as SourceReport["images"] };
}

export default function GssSourceReportView({ state, verifiedDate }: { state: SourceReportState; verifiedDate: string }) {
  const { t, locale } = useUiLanguage();
  if (state.status === "loading") return <p className={styles.sourceStatus} role="status">{t("Checking for the latest GSS source report…")}</p>;
  if (state.status === "error") return <p className={styles.sourceStatus} role="status">{t("The latest GSS source report could not be loaded. The verified report below is dated")}{" "}{formatReportDate(verifiedDate, locale)}.</p>;
  if (state.report.date <= verifiedDate) return <p className={styles.sourceStatus} role="status">{t("No newer source report was found. The verified report below is dated")}{" "}{formatReportDate(verifiedDate, locale)}.</p>;
  return <section className={styles.sourceReport} aria-labelledby="gss-source-title">
    <header><h2 id="gss-source-title">{t("Latest GSS source report")}</h2><time dateTime={state.report.date}>{formatReportDate(state.report.date, locale)}</time></header>
    <p>{t("Original report images. The verified tables below are from an earlier report.")}</p>
    {state.report.images.map(image => <figure key={image.period}><figcaption>{t(image.period)}</figcaption><picture style={{ display: 'contents' }}><img src={image.dataUrl} alt={t("{value0} in the Marriott GSS report dated {value1}", { value0: image.period, value1: formatReportDate(state.report.date, locale) })} /></picture></figure>)}
  </section>;
}

