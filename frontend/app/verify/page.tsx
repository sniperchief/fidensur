/**
 * Index of rounds.
 *
 * Deliberately read-only and wallet-free: auditing is something a stranger does, and requiring
 * them to connect a wallet to look would be both unnecessary and a little sinister. It reads the
 * chain over a public RPC and nothing else.
 *
 * ## Why this shares the dashboard's plumbing
 *
 * This page used to carry its own copy of the round-fetching logic — the same `nextRoundId` read,
 * the same bounded loop, the same cap, written twice. Two implementations of "list the rounds"
 * drift, and the one nobody is looking at drifts first. It now uses `useRounds()` and the same
 * table component as the workspace, so a round row looks and reads identically wherever it
 * appears, and there is one place to fix if it is wrong.
 */

"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { AllocationTable } from "@/components/app/AllocationTable";
import { IconInbox, IconSearch } from "@/components/ui/Icons";
import { MetricCard } from "@/components/ui/MetricCard";
import { COSTON2 } from "@/lib/contracts";
import { formatCount, formatTokenAmount } from "@/lib/format";
import { CONTRACT, summarizeRounds, useRounds } from "@/lib/rounds";

const LIMIT = 50;

export default function VerifyIndexPage() {
  const router = useRouter();
  const { listings, total, loading, error, configured, reload } = useRounds(LIMIT);
  const [lookup, setLookup] = useState("");

  const trimmed = lookup.trim();
  const valid = /^\d+$/.test(trimmed);
  const summary = listings ? summarizeRounds(listings) : null;

  return (
    <main className="report">
      <div className="index-head">
        <div>
          <p className="verdict-eyebrow">Verification explorer</p>
          <h1>Every round, and the evidence behind it</h1>
          <p className="index-lede">
            Each round publishes a Merkle root, a total and a recipient count. None publishes who
            got what. Open one to check the enclave&rsquo;s signature yourself — no wallet needed.
          </p>
        </div>

        <form
          className="index-lookup"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) router.push(`/verify/${trimmed}`);
          }}
        >
          <label className="visually-hidden" htmlFor="round-lookup">
            Round number
          </label>
          <input
            id="round-lookup"
            className="text-input"
            inputMode="numeric"
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="Go to round…"
            autoComplete="off"
          />
          <button className="btn btn-primary" type="submit" disabled={!valid}>
            <IconSearch size={15} />
            Open
          </button>
        </form>
      </div>

      {!configured && (
        <div className="callout fail">
          <strong>NEXT_PUBLIC_FIDENSUR_CONTRACT is not set.</strong> There is no contract to read.
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

      <div className="metric-grid" style={{ marginTop: "var(--s8)" }}>
        <MetricCard
          label="Rounds created"
          loading={loading}
          value={formatCount(total)}
          foot="Numbered from 0, in the order they were created"
        />
        <MetricCard
          label="Finalized"
          loading={loading}
          value={summary ? formatCount(summary.finalizedCount) : "—"}
          foot="A signed enclave result was verified on-chain"
        />
        <MetricCard
          label="Allocated in total"
          loading={loading}
          value={summary ? formatTokenAmount(summary.totalFunded) : "—"}
          unit="C2FLR"
          foot="Sum of every round's funded balance"
        />
        <MetricCard
          label="Recipients"
          loading={loading}
          value={summary ? formatCount(summary.recipientsAllocated) : "—"}
          foot="Across finalized rounds — counts only, never identities"
        />
      </div>

      <section className="table-card" style={{ marginTop: "var(--s6)" }}>
        <div className="table-head">
          <h2>Rounds</h2>
          {total > BigInt(LIMIT) && (
            <span className="hint" style={{ margin: 0 }}>
              Showing the most recent {LIMIT}
            </span>
          )}
        </div>

        {loading && (
          <p className="hint" style={{ padding: "var(--s6)" }}>
            Reading rounds from {COSTON2.name}…
          </p>
        )}

        {!loading && listings && listings.length > 0 && <AllocationTable listings={listings} />}

        {!loading && listings && listings.length === 0 && (
          <div className="empty-state">
            <span className="empty-mark" aria-hidden="true">
              <IconInbox size={20} />
            </span>
            <h3>No rounds yet</h3>
            <p>
              This deployment has not created any allocation rounds. There is nothing to verify
              until one exists.
            </p>
            <Link className="btn btn-secondary" href="/org">
              Open the console
            </Link>
          </div>
        )}
      </section>

      <p className="hint" style={{ marginTop: "var(--s6)" }}>
        Reading contract <code>{CONTRACT ?? "(unset)"}</code> on {COSTON2.name} over a public RPC.
        Nothing on this page passes through a Fidensur server.
      </p>
    </main>
  );
}
