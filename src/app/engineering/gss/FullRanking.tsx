"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import styles from "./GssScorecard.module.css";
import type { Ranking } from "./gss-latest-rankings";

export function SourceTrend({ direction }: { direction: "up" | "down" | "flat" }) {
  const { t } = useUiLanguage();
  return <span className={styles[direction]} role="img" aria-label={t("Source trend: {direction}", { direction: t(direction) })} />;
}

export function Thresholds() {
  const { t } = useUiLanguage();
  return <table className={styles.legend} aria-label={t("2026 ITR Thresholds")}>
    <thead><tr><td className={styles.legendBlank} /><th colSpan={4}>{t("2026 ITR Thresholds")}</th></tr><tr><td className={styles.legendBlank} /><th className={styles.green} scope="col"><span className={styles.legendLabel}>{t("GREEN")}</span></th><th className={styles.clear} scope="col"><span className={styles.legendLabel}>{t("CLEAR")}</span></th><th className={styles.yellow} scope="col"><span className={styles.legendLabel}>{t("YELLOW")}</span></th><th className={styles.red} scope="col"><span className={styles.legendLabel}>{t("RED")}</span></th></tr></thead>
    <tbody><tr><th scope="row">{t("US | CAN: Luxury")}</th><td className={styles.green}>80.0+</td><td className={styles.clear}>79.9-65.0</td><td className={styles.yellow}>64.9-56.0</td><td className={styles.red}>{t("Below 56.0")}</td></tr><tr><th scope="row">{t("US | CAN: Premium & Select")}</th><td className={styles.green}>80.0+</td><td className={styles.clear}>79.9-61.0</td><td className={styles.yellow}>60.9-53.0</td><td className={styles.red}>{t("Below 53.0")}</td></tr></tbody>
  </table>;
}

export default function FullRanking({ ranking, reportDateLabel, withLegend = false }: { ranking: Ranking; reportDateLabel: string; withLegend?: boolean }) {
  const { t } = useUiLanguage();
  const prefix = ranking.period === "MTD" ? "MTD" : "WTD";
  return <section className={styles.rankingSection} aria-label={t(ranking.period)} data-period={prefix}>
      <header className={styles.graphicHeader}>
        <h2>{t("Marriott Rankings")}<span>{t(ranking.period)}</span></h2>{withLegend && <div className={styles.sharedLegend}><Thresholds /></div>}
      </header>
    <div className={styles.fullScroll} tabIndex={0} role="region" aria-label={t("Marriott Rankings {value0}, {reportDateLabel}", { value0: t(ranking.period), reportDateLabel: reportDateLabel })}>
    <div className={styles.sourceGraphic}>
      <table className={styles.rankingTable} data-ranking={prefix}>
        <caption className={styles.srOnly}>{t("All")}{" "}{ranking.rows.length} {ranking.rows.length === 1 ? t("property") : t("properties")}{" "}{t("in the")}{" "}{reportDateLabel}{" "}{t("Marriott Rankings")}{" "}{t(ranking.period)}{" "}{t("source graphic")}</caption>
        <colgroup><col style={{ width: "41%" }} /><col style={{ width: "8%" }} />{Array.from({ length: 6 }, (_, i) => <col key={i} />)}<col style={{ width: "24px" }} /></colgroup>
        <thead><tr><th scope="col">{t("Property")}</th><th scope="col">{t("Sample Size")}</th><th scope="col">{t("Intent to Recommend (Property)")}</th><th scope="col">{t("Elite Appreciation")}</th><th scope="col">{t("Cleanliness")}</th><th scope="col">{t("Staff Service")}</th><th scope="col">{t("Maintenance and Upkeep")}</th><th scope="col">{t("Food and Beverage")}</th><th scope="col"><span className={styles.srOnly}>{t("Source trend")}</span></th></tr></thead>
        <tbody>{ranking.rows.map(row => <tr key={row.property} className={styles[row.color]} data-property={row.property}><th scope="row">{row.property}</th><td data-label={t("Sample Size")}>{row.sampleSize}</td>{row.scores.map((score, index) => <td key={index} data-label={["Intent to Recommend (Property)", "Elite Appreciation", "Cleanliness", "Staff Service", "Maintenance and Upkeep", "Food and Beverage"][index]}>{score.toFixed(1)}</td>)}<td className={styles.trend} data-label={t("Source trend")}><SourceTrend direction={row.trend} /></td></tr>)}</tbody>
      </table>
    </div>
    </div>
  </section>;
}





