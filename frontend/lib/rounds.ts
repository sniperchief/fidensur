/**
 * The dashboard's data layer.
 *
 * Every figure the workspace shows is derived here, from chain state, and nowhere else. There is
 * no mock module and no sample fallback: a dashboard that invents a treasury balance when the RPC
 * is unreachable is worse than one that says the RPC is unreachable, because the second is a
 * problem you can fix and the first is a decision you might act on.
 *
 * Kept free of JSX so the components above it stay presentational and this stays testable. The
 * only React here is the hook that owns the fetch lifecycle.
 *
 * ## Why it reads state rather than events
 *
 * Round ids are dense from 0, so `nextRoundId` plus a bounded loop of `getRound` gets the whole
 * list. `getLogs` would be fewer calls but public RPCs commonly cap block ranges, and a dashboard
 * that works against one provider and silently truncates against another is a bad trade.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { createPublicClient, http, type Address } from "viem";

import { COSTON2, FIDENSUR_READ_ABI, type Round } from "./contracts";

export const CONTRACT = (process.env.NEXT_PUBLIC_FIDENSUR_CONTRACT || undefined) as
  | Address
  | undefined;

const client = createPublicClient({ chain: COSTON2, transport: http() });

/** Status values from `Fidensur.RoundStatus`, named so comparisons below read as English. */
export const STATUS = {
  None: 0,
  Open: 1,
  Committed: 2,
  Computing: 3,
  Finalized: 4,
  Closed: 5,
  Cancelled: 6,
} as const;

export interface RoundListing {
  id: bigint;
  round: Round;
}

export interface RoundsState {
  listings: RoundListing[] | null;
  /** `nextRoundId` — the number ever created, which may exceed what is listed. */
  total: bigint;
  loading: boolean;
  error: string | null;
  /** False when no contract address is configured. A distinct case from an error. */
  configured: boolean;
  reload: () => void;
}

/**
 * Reads the most recent rounds, newest first.
 *
 * One RPC call per round, so the cap is not cosmetic — an unbounded list would fire hundreds of
 * requests at a public endpoint on page load.
 */
export function useRounds(limit = 50): RoundsState {
  const [listings, setListings] = useState<RoundListing[] | null>(null);
  const [total, setTotal] = useState<bigint>(0n);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!CONTRACT) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const next = (await client.readContract({
          address: CONTRACT,
          abi: FIDENSUR_READ_ABI,
          functionName: "nextRoundId",
        })) as bigint;

        if (cancelled) return;
        setTotal(next);

        const ids: bigint[] = [];
        for (let id = next - 1n; id >= 0n && ids.length < limit; id -= 1n) ids.push(id);

        const rows = await Promise.all(
          ids.map(async (id) => ({
            id,
            round: (await client.readContract({
              address: CONTRACT,
              abi: FIDENSUR_READ_ABI,
              functionName: "getRound",
              args: [id],
            })) as Round,
          })),
        );

        if (!cancelled) setListings(rows);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [limit, nonce]);

  return { listings, total, loading, error, configured: Boolean(CONTRACT), reload };
}

export interface TreasurySummary {
  /**
   * What the contract still holds: funded minus claimed, over rounds that have not been swept.
   *
   * Not "treasury balance" — the organization's own wallet is not part of this, and saying so
   * would invite someone to reconcile against a number this app has never seen.
   */
  heldByContract: bigint;
  totalFunded: bigint;
  /** Allocated but not yet claimed, across finalized rounds. Money with a named owner. */
  unclaimed: bigint;
  /** The newest round that has not reached Finalized. What the organization is working on. */
  activeRound: RoundListing | null;
  /** Rounds whose enclave result has not been relayed on-chain yet. */
  awaitingFinalization: number;
  finalizedCount: number;
  /** Recipients across finalized rounds. Allocated, not necessarily claimed. */
  recipientsAllocated: number;
  unsweptCount: number;
}

export function summarizeRounds(listings: RoundListing[]): TreasurySummary {
  let heldByContract = 0n;
  let totalFunded = 0n;
  let unclaimed = 0n;
  let awaitingFinalization = 0;
  let finalizedCount = 0;
  let recipientsAllocated = 0;
  let unsweptCount = 0;
  let activeRound: RoundListing | null = null;

  for (const listing of listings) {
    const { round } = listing;
    totalFunded += round.funded;

    // A swept round has already returned its remainder to the organization, so it contributes
    // nothing to what the contract holds — regardless of what `funded` still reports.
    if (!round.swept && round.status !== STATUS.Cancelled) {
      heldByContract += round.funded - round.totalClaimed;
      unsweptCount += 1;
    }

    if (round.status >= STATUS.Finalized && round.status !== STATUS.Cancelled) {
      finalizedCount += 1;
      recipientsAllocated += round.recipientCount;
      unclaimed += round.totalAllocated - round.totalClaimed;
    }

    if (round.status === STATUS.Computing) awaitingFinalization += 1;

    // `listings` arrives newest first, so the first in-flight round found is the newest one.
    const inFlight =
      round.status === STATUS.Open ||
      round.status === STATUS.Committed ||
      round.status === STATUS.Computing;
    if (inFlight && activeRound === null) activeRound = listing;
  }

  return {
    heldByContract,
    totalFunded,
    unclaimed,
    activeRound,
    awaitingFinalization,
    finalizedCount,
    recipientsAllocated,
    unsweptCount,
  };
}

export interface RoundStage {
  title: string;
  detail: string;
  state: "done" | "active" | "pending";
}

/**
 * A round's lifecycle as a timeline.
 *
 * Each stage is decided by chain state, never by a local step counter — a browser that missed a
 * receipt would otherwise show a stage as complete that the chain does not agree happened.
 *
 * Exactly one stage is `active`: the first one not yet done, and only while the round is still
 * moving. A finished round has no active stage, because nothing is in progress.
 */
export function roundStages(round: Round): RoundStage[] {
  // Cancelled is not a point on the normal path — the status number happens to sort above
  // Finalized, and treating it ordinally would mark stages complete that never happened.
  if (round.status === STATUS.Cancelled) {
    return [
      { title: "Round created", detail: "Token and claim window fixed on-chain.", state: "done" },
      { title: "Cancelled", detail: "The round was cancelled before it settled.", state: "done" },
    ];
  }

  const raw: { title: string; detail: string; done: boolean }[] = [
    {
      title: "Round created",
      detail: "Token and claim window fixed on-chain.",
      done: round.status >= STATUS.Open,
    },
    {
      title: "Treasury funded",
      detail: "The contract holds the money before it promises it.",
      done: round.funded > 0n,
    },
    {
      title: "Policy committed",
      detail: "A hash of the encrypted policy is on-chain. The policy itself is not.",
      done: round.status >= STATUS.Committed,
    },
    {
      title: "Computation requested",
      detail: "Ciphertext dispatched to the enclave.",
      done: round.status >= STATUS.Computing,
    },
    {
      title: "Result verified and finalized",
      detail: "The contract recovered the enclave's signature and recorded the Merkle root.",
      done: round.status >= STATUS.Finalized,
    },
    {
      title: "Claims settled",
      detail: "The claim window closed and the remainder returned.",
      done: round.status >= STATUS.Closed,
    },
  ];

  // Exactly one `active`: the first stage not yet done. A fully complete round has none, because
  // nothing is in progress.
  const firstPending = raw.findIndex((stage) => !stage.done);

  return raw.map((stage, i) => ({
    title: stage.title,
    detail: stage.detail,
    state: stage.done ? "done" : i === firstPending ? "active" : "pending",
  }));
}
