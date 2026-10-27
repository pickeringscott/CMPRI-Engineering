import styles from "./ShutoffGuide.module.css";

type ReferenceImage = { src: string; width: number; height: number };
type ShutoffGuideProps = {
  images: Record<"water" | "gas" | "risers", ReferenceImage>;
};

/** Image URLs must be served with the existing Front Desk audience authorization. */
export default function ShutoffGuide({ images }: ShutoffGuideProps) {
  const sections = [
    {
      id: "water" as const,
      title: "Water main",
      location: "Sprinkler room – inner room",
      instruction: "Turn the RIGHT-HAND valve clockwise FIRMLY until FULLY CLOSED.",
      detail: "Use hands only; no outside leverage or tools. Do not touch the left-hand valve.",
      caption: "Right-hand valve: turn clockwise to shut off. Do not touch the lefthand valve.",
    },
    {
      id: "gas" as const,
      title: "Gas line – main shutoff",
      location: "Sprinkler room – inner room",
      instruction: "Turn the handle 90 degrees to OFF.",
      detail: "OFF = handle perpendicular to the pipe.",
      caption: "The reference shows the gas valve and the perpendicular handle position for OFF.",
    },
    {
      id: "risers" as const,
      title: "Sprinkler risers",
      location: "Sprinkler room – outer room",
      instruction: "Close valves in order 1, 2, then 3. Turn each handwheel firmly until fully closed.",
      detail: "The indicator paddle is horizontal, aligned with the pipe, when closed.",
      caption: "Shutoff order: 1 → 2 → 3 (right to left).",
    },
  ];

  return (
    <article className={styles.document} aria-label="Shutoff reference guide">
      <header className={styles.header}>
        <p className={styles.eyebrow}>Front Desk Quick Guides</p>
        <h1>Shutoff reference guide</h1>
        <p className={styles.notice}>Authorized personnel only.</p>
      </header>
      {sections.map((section) => (
        <section className={styles.section} key={section.id} aria-labelledby={`shutoff-${section.id}`}>
          <h2 id={`shutoff-${section.id}`}>{section.title}</h2>
          <p className={styles.location}><strong>Location:</strong> {section.location}</p>
          <figure>
            {/* Preserve the supplied color reference and every existing annotation. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={images[section.id].src} width={images[section.id].width} height={images[section.id].height} alt={section.caption} />
            <figcaption>{section.caption}</figcaption>
            <a href={images[section.id].src} target="_blank" rel="noopener noreferrer" className={styles.imageLink}>Open full-size {section.title.toLowerCase()} reference</a>
          </figure>
          <div className={styles.instructions}>
            <p><strong>{section.instruction}</strong></p>
            <p>{section.detail}</p>
            {section.id === "risers" && <p>Sequence supplied by site engineer. Authorized personnel only; follow site fire-protection procedures.</p>}
          </div>
        </section>
      ))}
      <footer className={styles.footer}>
        <h2>Winter preparedness – posting and water-shutoff training</h2>
        <p>Train staff to locate and operate water shutoffs. Post photos and drawings/maps near time clocks, in back-of-house areas, and in the emergency manual. These photos do not replace maps or training.</p>
      </footer>
    </article>
  );
}
