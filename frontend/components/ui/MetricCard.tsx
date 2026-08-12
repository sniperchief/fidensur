/**
 * Metric card.
 *
 * A number, what it counts, and where it came from. The third part is the one usually left out,
 * and it is the one that decides whether a treasury figure can be acted on: "1,240 C2FLR" is a
 * fact only once you know whether it is funded, allocated, or still claimable.
 *
 * The value renders in tabular figures (see `.metric-value` in globals.css) so a column of cards
 * lines up digit-for-digit.
 */

import type { ReactNode } from "react";

export function MetricCard({
  label,
  value,
  unit,
  foot,
  loading = false,
  text = false,
}: {
  label: string;
  value: ReactNode;
  /** Rendered smaller and muted beside the figure — "C2FLR", "rounds". */
  unit?: string;
  /** The provenance line. Say what the number is derived from, not what it implies. */
  foot?: ReactNode;
  loading?: boolean;
  /** Set for values that are names rather than quantities, which need a smaller size to fit. */
  text?: boolean;
}) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>

      {loading ? (
        <>
          <span className="metric-skeleton" aria-hidden="true" />
          <span className="metric-foot">
            <span className="metric-skeleton line short" aria-hidden="true" />
          </span>
          <span className="visually-hidden">Loading {label}</span>
        </>
      ) : (
        <>
          <span className={text ? "metric-value is-text" : "metric-value"}>
            {value}
            {unit && <span className="unit">{unit}</span>}
          </span>
          {foot && <span className="metric-foot">{foot}</span>}
        </>
      )}
    </div>
  );
}
