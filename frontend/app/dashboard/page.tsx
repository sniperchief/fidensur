/**
 * Workspace overview.
 *
 * Answers the four questions a treasury operator opens a dashboard to answer, in this order:
 * what does the contract hold, what is in flight, what needs me, and what is done. Each figure is
 * derived from chain state in lib/rounds.ts — nothing here is sample data, and when the chain
 * cannot be read the page says so rather than showing a plausible number.
 *
 * ## Why the labels are wordy
 *
 * "Held by the contract" rather than "Treasury balance"; "Awaiting finalization" rather than
 * "Pending". The short versions read better and mean something slightly wrong — the organization's
 * own wallet is not counted here, and "pending" hides which of four states a round is actually
 * in. On a page whose numbers might be reconciled against an explorer, precise beats tidy.
 */

"use client";

import Link from "next/link";

import { AllocationTable } from "@/components/app/AllocationTable";
import { IconArrowRight, IconPlus } from "@/components/ui/Icons";
import { MetricCard } from "@/components/ui/MetricCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Timeline } from "@/components/ui/Timeline";
import { NATIVE_TOKEN, statusName } from "@/lib/contracts";
import { formatCount, formatDateTime, formatTokenAmount } from "@/lib/format";
import { roundStages, summarizeRounds, useRounds } from "@/lib/rounds";

/** How many rounds the overview previews before deferring to the allocations page. */
const PREVIEW = 5;

export default function OverviewPage() {
  const { listings, total, loading, error, configured, reload } = useRounds();
  const summary = listings ? summarizeRounds(listings) : null;
  const active = summary?.activeRound ?? null;

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>
            Every figure below is read from the Fidensur contract on Coston2 at page load. No
            allocation detail is available to this page — it never was, and that is the point.
          </p>
          <Link className="btn btn-primary page-head-action" href="/org">
            <IconPlus size={15} />
            New round
          </Link>
        </div>
      </div>

      {!configured && (
        <div className="callout fail">
          <strong>NEXT_PUBLIC_FIDENSUR_CONTRACT is not set.</strong> The workspace has no contract
          to read. Set it in the frontend environment and restart.
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

      <div className="metric-grid">
        <MetricCard
          label="Held by the contract"
          loading={loading}
          value={summary ? formatTokenAmount(summary.heldByContract) : "—"}
          unit="C2FLR"
          foot={
            summary
              ? `Funded minus claimed, across ${formatCount(summary.unsweptCount)} unswept round${summary.unsweptCount === 1 ? "" : "s"}`
              : undefined
          }
        />
        <MetricCard
          label="Active round"
          loading={loading}
          text
          value={active ? `Round ${String(active.id)}` : "None in flight"}
          foot={
            active ? (
              <StatusBadge status={active.round.status} />
            ) : (
              "Every round has been finalized or closed"
            )
          }
        />
        <MetricCard
          label="Awaiting finalization"
          loading={loading}
          value={summary ? formatCount(summary.awaitingFinalization) : "—"}
          foot="Enclave result computed but not yet relayed on-chain"
        />
        <MetricCard
          label="Finalized rounds"
          loading={loading}
          value={summary ? formatCount(summary.finalizedCount) : "—"}
          foot={
            summary
              ? `${formatCount(summary.recipientsAllocated)} recipients allocated in total`
              : undefined
          }
        />
      </div>

      {active && (
        <section className="table-card">
          <div className="table-head">
            <h2>Round {String(active.id)} — in progress</h2>
            <Link className="row-action" href={`/verify/${active.id}`}>
              Verification report
              <IconArrowRight size={13} />
            </Link>
          </div>

          <div className="round-panel">
            <Timeline stages={roundStages(active.round)} />

            <div className="panel-facts">
              <div>
                <span className="fact-label">Status</span>
                <span className="fact-value">{statusName(active.round.status)}</span>
              </div>
              <div>
                <span className="fact-label">Funded</span>
                <span className="fact-value">
                  {formatTokenAmount(active.round.funded)}{" "}
                  {active.round.token === NATIVE_TOKEN ? "C2FLR" : "tokens"}
                </span>
              </div>
              <div>
                <span className="fact-label">Claim window</span>
                <span className="fact-value">
                  {active.round.claimDeadline
                    ? formatDateTime(active.round.claimDeadline)
                    : "Set when the round is finalized"}
                </span>
              </div>
              <div>
                <span className="fact-label">Next step</span>
                <span className="fact-value">
                  <Link href="/org">Continue in the console →</Link>
                </span>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="table-card">
        <div className="table-head">
          <h2>Recent allocations</h2>
          {listings && listings.length > PREVIEW && (
            <Link className="row-action" href="/dashboard/allocations">
              View all {String(total)}
              <IconArrowRight size={13} />
            </Link>
          )}
        </div>

        {loading && <p className="hint" style={{ padding: "var(--s6)" }}>Reading rounds…</p>}
        {!loading && listings && <AllocationTable listings={listings.slice(0, PREVIEW)} />}
      </section>
    </div>
  );
}
