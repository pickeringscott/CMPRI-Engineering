import styles from "./GssScorecard.module.css";
import type { Ranking } from "./gss-latest-rankings";

export function SourceTrend({ direction }: { direction: "up" | "down" }) {
  return <span className={direction === "up" ? styles.up : styles.down} role="img" aria-label={`Source trend: ${direction}`} />;
}

export function Thresholds() {
  return <table className={styles.legend} aria-label="2026 ITR Thresholds">
    <thead><tr><td className={styles.legendBlank} /><th colSpan={4}>2026 ITR Thresholds</th></tr><tr><td className={styles.legendBlank} /><th className={styles.green} scope="col"><span className={styles.legendLabel}>GREEN</span></th><th className={styles.clear} scope="col"><span className={styles.legendLabel}>CLEAR</span></th><th className={styles.yellow} scope="col"><span className={styles.legendLabel}>YELLOW</span></th><th className={styles.red} scope="col"><span className={styles.legendLabel}>RED</span></th></tr></thead>
    <tbody><tr><th scope="row">US | CAN: Luxury</th><td className={styles.green}>80.0+</td><td className={styles.clear}>79.9-65.0</td><td className={styles.yellow}>64.9-56.0</td><td className={styles.red}>Below 56.0</td></tr><tr><th scope="row">US | CAN: Premium &amp; Select</th><td className={styles.green}>80.0+</td><td className={styles.clear}>79.9-61.0</td><td className={styles.yellow}>60.9-53.0</td><td className={styles.red}>Below 53.0</td></tr></tbody>
  </table>;
}

export default function FullRanking({ ranking, withLegend = false, reportDate = "2026-10-12" }: { ranking: Ranking; withLegend?: boolean; reportDate?: string }) {
  const dateLabel = new Date(reportDate + "T12:00:00Z").toLocaleDateString("en-US", {month:"long",day:"numeric",year:"numeric",timeZone:"UTC"});
  const prefix = ranking.period === "MTD" ? "MTD" : "WTD";
  return <section className={styles.rankingSection} aria-label={ranking.period} data-period={prefix}>
      <header className={styles.graphicHeader}>
        <h2>Marriott Rankings<span>{ranking.period}</span></h2>{withLegend && <div className={styles.sharedLegend}><Thresholds /></div>}
      </header>
    <div className={styles.fullScroll} tabIndex={0} role="region" aria-label={`Marriott Rankings ${ranking.period}, ${dateLabel}`}>
    <div className={styles.sourceGraphic}>
      <table className={styles.rankingTable} data-ranking={prefix}>
        <caption className={styles.srOnly}>All {ranking.rows.length} properties in the {dateLabel} Marriott Rankings {ranking.period} source graphic</caption>
        <colgroup><col style={{ width: "41%" }} /><col style={{ width: "8%" }} />{Array.from({ length: 6 }, (_, i) => <col key={i} />)}<col style={{ width: "24px" }} /></colgroup>
        <thead><tr><th scope="col">Property</th><th scope="col">Sample Size</th><th scope="col">Intent to<br />Recommend<br />(Property)</th><th scope="col">Elite<br />Appreciation</th><th scope="col">Cleanliness</th><th scope="col">Staff<br />Service</th><th scope="col">Maintenance<br />and Upkeep</th><th scope="col">Food and<br />Beverage</th><th scope="col"><span className={styles.srOnly}>Source trend</span></th></tr></thead>
        <tbody>{ranking.rows.map(row => <tr key={row.property} className={styles[row.color]} data-property={row.property}><th scope="row">{row.property}</th><td data-label="Sample Size">{row.sampleSize}</td>{row.scores.map((score, index) => <td key={index} data-label={["Intent to Recommend (Property)", "Elite Appreciation", "Cleanliness", "Staff Service", "Maintenance and Upkeep", "Food and Beverage"][index]}>{score.toFixed(1)}</td>)}<td className={styles.trend} data-label="Source trend"><SourceTrend direction={row.trend} /></td></tr>)}</tbody>
      </table>
    </div>
    </div>
  </section>;
}





