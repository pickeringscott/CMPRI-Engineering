import styles from "./TicketEscalation.module.css";

/** Glossy red exclamation mark drawn with HTML and CSS, without an image asset. */
export default function TicketEscalationMark() {
  return <span className={styles.mark} aria-hidden="true"><span className={styles.stem} /><span className={styles.dot} /></span>;
}
