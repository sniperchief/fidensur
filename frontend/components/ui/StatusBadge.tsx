/**
 * Status badge.
 *
 * Small, bordered, one line — never a large colourful pill. On a page listing twenty rounds the
 * badges are read as a column, and anything louder than this turns the table into a chart of
 * itself.
 *
 * ## The labels are the contract's, not marketing's
 *
 * The states below are exactly `Fidensur.RoundStatus`. It is tempting to rename `Computing` to
 * something friendlier like "Processing", but a reader who then goes looking at the chain, or at
 * a revert message, finds a word that appears nowhere. On a product whose whole proposition is
 * that you can go and check, the UI vocabulary has to be the checkable one.
 *
 * Colour is never the only signal: every badge carries its word.
 */

import { ROUND_STATUS, type RoundStatus } from "@/lib/contracts";

export type BadgeKind = "neutral" | "progress" | "pass" | "warn" | "fail";

const STATUS_KIND: Record<RoundStatus, BadgeKind> = {
  None: "neutral",
  Open: "neutral",
  Committed: "progress",
  Computing: "progress",
  Finalized: "pass",
  Closed: "neutral",
  Cancelled: "fail",
};

/** What each state means, for the `title` tooltip and for detail views. */
export const STATUS_MEANING: Record<RoundStatus, string> = {
  None: "No round exists at this number.",
  Open: "Created and accepting funds. No policy has been committed yet.",
  Committed: "A policy commitment is on-chain. The ciphertext has not been dispatched.",
  Computing: "The enclave is evaluating the policy. Awaiting a signed result to relay.",
  Finalized: "A signed result was verified on-chain. Recipients can claim.",
  Closed: "The claim window has passed and the remainder returned to the organization.",
  Cancelled: "The round was cancelled before it settled.",
};

export function StatusBadge({ status }: { status: number }) {
  const label: RoundStatus = ROUND_STATUS[status] ?? "None";
  const kind = STATUS_KIND[label];

  return (
    <span className="badge" data-kind={kind} data-live={label === "Computing"} title={STATUS_MEANING[label]}>
      <span className="badge-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * The same visual treatment for anything that is not a round status — a network name, an
 * attestation verdict, a "sample data" marker.
 */
export function Badge({
  kind = "neutral",
  live = false,
  dot = true,
  children,
  title,
}: {
  kind?: BadgeKind;
  live?: boolean;
  dot?: boolean;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span className="badge" data-kind={kind} data-live={live} title={title}>
      {dot && <span className="badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
