/**
 * Allocations.
 *
 * The full list of rounds, newest first, capped at what one page of RPC calls can reasonably
 * fetch. The cap is stated on the page rather than left implicit — a treasury list that silently
 * truncates is the kind of thing someone only discovers when a round they were looking for is
 * missing.
 *
 * Filtering is by status and nothing else. Search would need a field to search: rounds have no
 * name on-chain, only a number and an organization, and inventing a "purpose" column that the
 * contract does not store would put a label in the UI that no auditor could ever confirm.
 */

"use client";

import { useMemo, useState } from "react";

import { AllocationTable, NoRounds } from "@/components/app/AllocationTable";
import { ROUND_STATUS } from "@/lib/contracts";
import { formatCount } from "@/lib/format";
import { STATUS, useRounds } from "@/lib/rounds";

const LIMIT = 50;

type Filter = "all" | "in-flight" | "finalized";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "in-flight", label: "In flight" },
  { value: "finalized", label: "Finalized" },
];

export default function AllocationsPage() {
  const { listings, total, loading, error, configured, reload } = useRounds(LIMIT);
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(() => {
    if (!listings) return null;
    if (filter === "all") return listings;

    return listings.filter(({ round }) => {
      const inFlight =
        round.status === STATUS.Open ||
        round.status === STATUS.Committed ||
        round.status === STATUS.Computing;
      return filter === "in-flight" ? inFlight : round.status >= STATUS.Finalized;
    });
  }, [listings, filter]);

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Allocations</h1>
          <p>
            Every round this contract has created. Amounts, counts and status come from chain
            state; the distribution behind each one does not appear here, or anywhere.
          </p>
        </div>
      </div>

      {!configured && (
        <div className="callout fail">
          <strong>NEXT_PUBLIC_FIDENSUR_CONTRACT is not set.</strong> Set it in the frontend
          environment and restart.
        </div>
      )}

      {error && (
        <div className="callout fail">
          <strong>Could not read the chain.</strong>
          <pre>
            <code>{error}</code>
          </pre>
          <button className="btn btn-ghost btn-sm" onClick={reload}>
            Try again
          </button>
        </div>
      )}

      <section className="table-card">
        <div className="table-head">
          <h2>
            {visible ? formatCount(visible.length) : "—"} round
            {visible?.length === 1 ? "" : "s"}
          </h2>

          <div className="mode-row" role="group" aria-label="Filter by status">
            {FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`mode-btn${filter === option.value ? " active" : ""}`}
                aria-pressed={filter === option.value}
                onClick={() => setFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {loading && (
          <p className="hint" style={{ padding: "var(--s6)" }}>
            Reading rounds…
          </p>
        )}

        {!loading && visible && visible.length > 0 && <AllocationTable listings={visible} />}

        {!loading && visible && visible.length === 0 && listings?.length === 0 && <NoRounds />}

        {!loading && visible && visible.length === 0 && (listings?.length ?? 0) > 0 && (
          <div className="empty-state">
            <h3>No rounds match this filter</h3>
            <p>
              {formatCount(listings?.length ?? 0)} round
              {listings?.length === 1 ? "" : "s"} exist, none of them{" "}
              {filter === "in-flight" ? "currently in flight" : "finalized"}.
            </p>
            <button className="btn btn-ghost btn-sm" onClick={() => setFilter("all")}>
              Show all
            </button>
          </div>
        )}
      </section>

      {!loading && total > BigInt(LIMIT) && (
        <p className="hint">
          Showing the most recent {LIMIT} of {String(total)} rounds created. Older rounds remain
          readable at <code>/verify/&lt;number&gt;</code> — the cap is on this listing, not on the
          contract.
        </p>
      )}

      <p className="hint">
        Status values are the contract&rsquo;s own: {ROUND_STATUS.slice(1).join(", ")}.
      </p>
    </div>
  );
}
