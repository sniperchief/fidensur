/**
 * Index of rounds.
 *
 * The per-round report at /verify/[round] was already complete but unreachable unless you happened
 * to know a round number. This is the way in.
 *
 * Deliberately read-only and wallet-free: auditing is something a stranger does, and requiring them
 * to connect a wallet to look would be both unnecessary and a little sinister. It reads the chain
 * over a public RPC and nothing else.
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPublicClient, http, type Address } from "viem";

import {
  COSTON2,
  FIDENSUR_READ_ABI,
  NATIVE_TOKEN,
  formatAmount,
  statusName,
  type Round,
} from "@/lib/contracts";

const CONTRACT = process.env.NEXT_PUBLIC_FIDENSUR_CONTRACT as Address | undefined;

const client = createPublicClient({ chain: COSTON2, transport: http() });

/**
 * How many rounds to show.
 *
 * Reading each round is one RPC call, so an unbounded list would fire hundreds at a public endpoint
 * on page load. Newest first, because that is what anyone is looking for.
 */
const LIMIT = 50;

interface Listing {
  id: bigint;
  round: Round;
}

export default function VerifyIndexPage() {
  const [rounds, setRounds] = useState<Listing[] | null>(null);
  const [total, setTotal] = useState<bigint>(0n);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!CONTRACT) throw new Error("NEXT_PUBLIC_FIDENSUR_CONTRACT is not set");

        const next = (await client.readContract({
          address: CONTRACT,
          abi: FIDENSUR_READ_ABI,
          functionName: "nextRoundId",
        })) as bigint;

        if (cancelled) return;
        setTotal(next);

        // Newest first, capped. Round ids are dense from 0, so no log scan is needed — and reading
        // state is more reliable than getLogs, which public RPCs commonly restrict by block range.
        const ids: bigint[] = [];
        for (let id = next - 1n; id >= 0n && ids.length < LIMIT; id -= 1n) ids.push(id);

        const listings = await Promise.all(
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

        if (!cancelled) setRounds(listings);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="console">
      <h1>Verify a round</h1>
      <p className="tagline">
        Every round publishes a Merkle root, a total and a count. None publishes who got what.
      </p>

      {error && (
        <div className="callout fail">
          <strong>Could not read the chain.</strong>
          <pre>
            <code>{error}</code>
          </pre>
        </div>
      )}

      {!error && rounds === null && <p className="hint">Reading rounds…</p>}

      {rounds !== null && rounds.length === 0 && (
        <div className="callout unknown">
          No rounds have been created on this deployment yet. The{" "}
          <Link href="/org">organization console</Link> creates the first one.
        </div>
      )}

      {rounds !== null && rounds.length > 0 && (
        <>
          <p className="hint">
            {String(total)} round{total === 1n ? "" : "s"} created
            {total > BigInt(LIMIT) ? `, showing the most recent ${LIMIT}` : ""}.
          </p>

          <table className="rounds">
            <thead>
              <tr>
                <th>Round</th>
                <th>Status</th>
                <th>Funded</th>
                <th>Allocated</th>
                <th>Recipients</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rounds.map(({ id, round }) => (
                <tr key={String(id)}>
                  <td>{String(id)}</td>
                  <td>{statusName(round.status)}</td>
                  <td>
                    {formatAmount(round.funded)}{" "}
                    {round.token === NATIVE_TOKEN ? "C2FLR" : "tokens"}
                  </td>
                  <td>{round.totalAllocated > 0n ? formatAmount(round.totalAllocated) : "—"}</td>
                  <td>{round.recipientCount || "—"}</td>
                  <td>
                    <Link href={`/verify/${id}`}>Report →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <p className="hint" style={{ marginTop: "2rem" }}>
        Contract <code>{CONTRACT ?? "(unset)"}</code> on Coston2.
      </p>
    </main>
  );
}
