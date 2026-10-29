import type { GssReport } from "@/lib/integrations/gss-publication";
import type { Ranking } from "./gss-latest-rankings";
import styles from "./GssScorecard.module.css";
import { verifiedGssReports } from "./gss-reports";
import FullRanking, { SourceTrend as Trend } from "./FullRanking";
import { latestRankings } from "./gss-latest-rankings";

const metrics = ["Intent to Recommend (Property)", "Elite Appreciation", "Cleanliness", "Staff Service", "Maintenance and Upkeep", "Food and Beverage"];
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export default function GssScorecard({ publications = [] }: { publications?: GssReport[] } = {}) {
  const saved = publications.map(report => ({date:report.date,snapshots:report.rankings.map(ranking=>{
    const room=ranking.rows.find(row=>/\(CMPRI\)$/.test(row.property));
    if(!room)throw new Error("Saved GSS source row missing");
    return {period:ranking.period,sampleSize:room.sampleSize,scores:room.scores,trend:room.trend};
  })}));
  const all=[...saved,...verifiedGssReports.filter(report=>!saved.some(row=>row.date===report.date))].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,4);
  const [latest, ...previous] = all;
  const rankings = (publications.find(report=>report.date===latest.date)?.rankings || latestRankings) as readonly Ranking[];
  return <div className={styles.scorecard}>
    <section aria-labelledby="gss-latest-title" className={styles.latest}>
      <header className={styles.heading}><h1 id="gss-latest-title">GSS Reports</h1><time dateTime={latest.date}>{dateLabel(latest.date)}</time></header>
      <div className={styles.fullPaper}>{rankings.map((ranking, index) => <FullRanking key={ranking.period} ranking={ranking} reportDate={latest.date} withLegend={index === 0} />)}</div>
    </section>
    <section className={styles.history} aria-labelledby="gss-history-title">
      <h2 id="gss-history-title">CMPRI · Previous three reports</h2>
      {previous.map(report => <article key={report.date} className={styles.previous}><h3><time dateTime={report.date}>{dateLabel(report.date)}</time></h3><div className={styles.paper}><div className={styles.scroll} tabIndex={0} role="region" aria-label={`CMPRI scores, ${dateLabel(report.date)}`}><table className={styles.table}>
        <caption className={styles.srOnly}>CMPRI — report dated {dateLabel(report.date)}</caption>
        <thead><tr><th scope="col">Reporting period</th><th scope="col">Sample Size</th>{metrics.map(metric => <th key={metric} scope="col">{metric === "Intent to Recommend (Property)" ? <><span className={styles.noWrap}>Intent to Recommend</span><br />(Property)</> : metric}</th>)}<th scope="col"><span className={styles.srOnly}>Source trend</span></th></tr></thead>
        <tbody>{report.snapshots.map(snapshot => <tr key={snapshot.period}><th scope="row">{snapshot.period}</th><td data-label="Sample Size">{snapshot.sampleSize}</td>{snapshot.scores.map((score, index) => <td key={metrics[index]} data-label={metrics[index]}>{score.toFixed(1)}</td>)}<td className={styles.trend} data-label="Source trend"><Trend direction={snapshot.trend} /></td></tr>)}</tbody>
      </table></div></div></article>)}
    </section>
    <p className={styles.note}>Taylor Johnson’s weekly GSS reports · Scores retain their source reporting periods: MTD, September, and Wave to Date. Arrows reproduce the source indicators.</p>
  </div>;
}





