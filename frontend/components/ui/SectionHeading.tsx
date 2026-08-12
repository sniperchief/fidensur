/**
 * Section heading.
 *
 * Eyebrow, heading, lede — always in that order, always with the same spacing, so a reader
 * scrolling the page learns the rhythm once and can then skim by shape.
 *
 * The lede is capped at `--prose` rather than the section width. A 1200px-wide paragraph is
 * unreadable no matter how good the typeface is.
 */

export function SectionHeading({
  eyebrow,
  title,
  lede,
  center = false,
  id,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  center?: boolean;
  id?: string;
}) {
  return (
    <div className={center ? "section-heading center" : "section-heading"}>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2 id={id}>{title}</h2>
      {lede && <p className="lede">{lede}</p>}
    </div>
  );
}
