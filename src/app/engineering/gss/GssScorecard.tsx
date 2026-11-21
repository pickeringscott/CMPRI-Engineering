"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import styles from "./GssScorecard.module.css";
import { verifiedGssReports } from "./gss-reports";
import FullRanking, { SourceTrend as Trend } from "./FullRanking";
import { latestRankings } from "./gss-latest-rankings";

const metrics = ["Intent to Recommend (Property)", "Elite Appreciation", "Cleanliness", "Staff Service", "Maintenance and Upkeep", "Food and Beverage"];
const dateLabel = (date: string, locale = "en-US") => new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export default function GssScorecard() {
  const { t, locale } = useUiLanguage();
  const [latest, ...previous] = verifiedGssReports;
  return <div className={styles.scorecard}>
    <section aria-labelledby="gss-latest-title" className={styles.latest}>
      <header className={styles.heading}><h1 data-cmpri-page-heading id="gss-latest-title">{t("GSS Reports")}</h1><time dateTime={latest.date}>{t("Verified report ·")}{" "}{dateLabel(latest.date, locale)}</time></header>
      <div className={styles.fullPaper}>{latestRankings.map((ranking, index) => <FullRanking key={ranking.period} ranking={ranking} reportDateLabel={dateLabel(latest.date, locale)} withLegend={index === 0} />)}</div>
    </section>
    <section className={styles.history} aria-labelledby="gss-history-title">
      <h2 id="gss-history-title">{t("CMPRI · Previous three reports")}</h2>
      {previous.map(report => <article key={report.date} className={styles.previous}><h3><time dateTime={report.date}>{dateLabel(report.date, locale)}</time></h3><div className={styles.paper}><div className={styles.scroll} tabIndex={0} role="region" aria-label={t("CMPRI scores, {value0}", { value0: dateLabel(report.date, locale) })}><table className={styles.table}>
        <caption className={styles.srOnly}>{t("CMPRI — report dated")}{" "}{dateLabel(report.date, locale)}</caption>
        <thead><tr><th scope="col">{t("Reporting period")}</th><th scope="col">{t("Sample Size")}</th>{metrics.map(metric => <th key={metric} scope="col">{metric === "Intent to Recommend (Property)" ? <><span className={styles.noWrap}>{t("Intent to Recommend")}</span><br />{t("(Property)")}</> : t(metric)}</th>)}<th scope="col"><span className={styles.srOnly}>{t("Source trend")}</span></th></tr></thead>
        <tbody>{report.snapshots.map(snapshot => <tr key={snapshot.period}><th scope="row">{t(snapshot.period)}</th><td data-label={t("Sample Size")}>{snapshot.sampleSize}</td>{snapshot.scores.map((score, index) => <td key={metrics[index]} data-label={t(metrics[index])}>{score.toFixed(1)}</td>)}<td className={styles.trend} data-label={t("Source trend")}><Trend direction={snapshot.trend} /></td></tr>)}</tbody>
      </table></div></div></article>)}
    </section>
    <p className={styles.note}>{t("Taylor Johnson’s weekly GSS reports · Scores retain their source reporting periods. Arrows reproduce the source indicators.")}</p>
  </div>;
}





