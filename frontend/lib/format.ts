/**
 * Display formatting.
 *
 * Separate from `contracts.ts` on purpose: that file is the typed contract surface, and a reader
 * checking what the UI can do on-chain should not have to wade past number formatting to find
 * out. Nothing here touches the chain or changes a value — only how it is written down.
 */

import { formatAmount } from "./contracts";

/**
 * A token amount, grouped for reading: `50000` becomes `50,000`.
 *
 * Grouping is applied to the integer part only. The fractional part is left ungrouped and
 * un-rounded beyond `formatAmount`'s precision, because a treasury figure that quietly rounds is
 * worse than a long one — someone reconciling against an explorer needs the digits to match.
 */
export function formatTokenAmount(value: bigint, precision = 4): string {
  const plain = formatAmount(value, 18, precision);
  const [whole = "0", frac] = plain.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

/** Plain integers in the same style, for counts. */
export function formatCount(value: number | bigint): string {
  return value.toLocaleString("en-US");
}

/**
 * A unix timestamp as a short absolute date.
 *
 * Absolute, never "3 days ago". Relative time is friendlier and useless for reconciliation: a
 * claim window closing "in 2 days" cannot be checked against anything, and the reader who cares
 * is precisely the one who needs the date.
 */
export function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
