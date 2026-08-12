/**
 * Recipient portal.
 *
 * A recipient learns their own allocation and spends it, without the organization mediating and
 * without anyone else learning anything.
 *
 * ## How the privacy actually works here
 *
 * The disclosure request carries a **fresh public key generated in this tab**. The enclave encrypts
 * the reply to it, and that reply travels back through a public proxy in the clear — anyone can read
 * the bytes, nobody but this browser can read the content. So requesting a disclosure publishes
 * *that you asked*, never *what you were told*.
 *
 * ## The limit this page states rather than hides
 *
 * Claiming is self-disclosure. `AllocationClaimed` carries the amount in the clear, so the moment a
 * recipient spends their allocation they publish it. That is inherent — a payment that moves real
 * value cannot also be invisible — and it is said plainly below rather than discovered afterwards.
 */

"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { formatEther, decodeAbiParameters, parseEventLogs, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import { RequireWallet } from "@/components/Wallet";
import {
  FIDENSUR_EVENTS_ABI,
  FIDENSUR_READ_ABI,
  FIDENSUR_WRITE_ABI,
  formatAmount,
  statusName,
  type Round,
} from "@/lib/contracts";
import { decryptDisclosure, generateDisclosureKeypair } from "@/lib/ecies";
import { checkDisclosure, type Disclosure } from "@/lib/merkle";
import { ProxyClient } from "@/lib/proxy";

const CONTRACT = process.env.NEXT_PUBLIC_FIDENSUR_CONTRACT as Address | undefined;
const PROXY_URL = process.env.NEXT_PUBLIC_EXT_PROXY_URL;

const INSTRUCTION_FEE = 1_000_000n;
const COMPUTING = 3;
const FINALIZED = 4;

export default function ClaimPage() {
  return (
    // `div`, not `main`: AppShell supplies the page's single `main` landmark.
    <div className="console">
      <h1>Claim an allocation</h1>
      <p className="tagline">
        Ask the enclave what you were allocated, check the proof yourself, then spend it.
      </p>

      {!CONTRACT ? (
        <div className="callout fail">
          <strong>NEXT_PUBLIC_FIDENSUR_CONTRACT is not set.</strong>
        </div>
      ) : (
        <RequireWallet>
          <Portal contract={CONTRACT} />
        </RequireWallet>
      )}
    </div>
  );
}

function Portal({ contract }: { contract: Address }) {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();

  const [lookup, setLookup] = useState("");
  const [roundId, setRoundId] = useState<bigint | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (id: bigint) => {
      setBusy("load");
      setError(null);
      setDisclosure(null);
      setClaimed(false);
      try {
        const data = (await publicClient!.readContract({
          address: contract,
          abi: FIDENSUR_READ_ABI,
          functionName: "getRound",
          args: [id],
        })) as Round;
        setRoundId(id);
        setRound(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [publicClient, contract],
  );

  /**
   * Requests a disclosure and decrypts it.
   *
   * The keypair is generated here and never leaves this function's scope — not stored, not logged,
   * not persisted. That means navigating away before the reply arrives loses the ability to read it
   * and the request must be made again. Persisting it to localStorage would be more forgiving and
   * would put the key that unlocks the allocation somewhere any script on the origin can read it.
   */
  const request = () =>
    guard("disclose", async () => {
      if (!PROXY_URL) throw new Error("NEXT_PUBLIC_EXT_PROXY_URL is not set");
      if (roundId === null || !round) throw new Error("no round loaded");

      const keys = generateDisclosureKeypair();

      const { request: sim } = await publicClient!.simulateContract({
        address: contract,
        abi: FIDENSUR_WRITE_ABI,
        functionName: "requestDisclosure",
        args: [roundId, keys.compressed],
        account: walletClient!.account,
        value: INSTRUCTION_FEE,
      } as never);
      const hash = await walletClient!.writeContract(sim as never);
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("requestDisclosure reverted");

      const logs = parseEventLogs({
        abi: FIDENSUR_EVENTS_ABI,
        eventName: "DisclosureRequested",
        logs: receipt.logs,
      });
      if (logs.length === 0) throw new Error("no DisclosureRequested event in the receipt");
      const instructionId = logs[0]!.args.instructionId as Hex;

      const result = await new ProxyClient(PROXY_URL).waitForResult(instructionId, {
        timeoutMs: 240_000,
        intervalMs: 5_000,
      });
      if (result.status !== 1) {
        // The enclave refuses rather than returning an empty success, so that this endpoint is not
        // a quieter way to test whether an address is in the round.
        throw new Error(result.log ?? "the enclave declined the request");
      }

      const [requester, , ciphertext] = decodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
        result.data,
      ) as [Address, bigint, Hex];

      if (requester.toLowerCase() !== address!.toLowerCase()) {
        throw new Error(`the reply is addressed to ${requester}, not to you`);
      }

      setDisclosure(await decryptDisclosure<Disclosure>(ciphertext, keys.privateKey));
    });

  const guard = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const claim = () =>
    guard("claim", async () => {
      if (!disclosure || roundId === null) throw new Error("no disclosure");
      const { request: sim } = await publicClient!.simulateContract({
        address: contract,
        abi: FIDENSUR_WRITE_ABI,
        functionName: "claim",
        args: [roundId, BigInt(disclosure.index), BigInt(disclosure.amount), disclosure.proof],
        account: walletClient!.account,
      } as never);
      const hash = await walletClient!.writeContract(sim as never);
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("claim reverted");
      setClaimed(true);
      await load(roundId);
    });

  const check = disclosure && round ? checkDisclosure(disclosure, round.merkleRoot) : null;
  const windowClosed = round ? Math.floor(Date.now() / 1000) > round.claimDeadline : false;

  return (
    <>
      <section className="step">
        <h2>Which round?</h2>
        <p className="why">
          You need only the round number. The organization does not have to send you anything, and
          cannot stop you asking.
        </p>
        <div className="lookup">
          <input
            className="text-input"
            inputMode="numeric"
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="round number"
          />
          <button
            className="wallet-btn"
            disabled={!/^\d+$/.test(lookup.trim()) || busy !== null}
            onClick={() => load(BigInt(lookup.trim()))}
          >
            {busy === "load" ? "Loading…" : "Load"}
          </button>
        </div>
      </section>

      {error && (
        <div className="callout fail">
          <strong>Failed.</strong>
          <pre>
            <code>{error}</code>
          </pre>
        </div>
      )}

      {round && roundId !== null && (
        <>
          <dl className="facts">
            <div>
              <dt>Round</dt>
              <dd>{String(roundId)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{statusName(round.status)}</dd>
            </div>
            <div>
              <dt>Recipients</dt>
              <dd>{round.recipientCount || "—"}</dd>
            </div>
            <div>
              <dt>Claim closes</dt>
              <dd>
                {round.claimDeadline
                  ? new Date(round.claimDeadline * 1000).toLocaleString()
                  : "not yet set"}
              </dd>
            </div>
          </dl>

          {round.status < COMPUTING && (
            <div className="callout unknown">
              This round has not been computed yet, so there is nothing to disclose. Come back once
              its status is Computing or Finalized.
            </div>
          )}

          {round.status >= COMPUTING && (
            <section className="step">
              <h2>1. Ask what you were allocated</h2>
              <p className="why">
                A fresh keypair is generated in this tab. The enclave encrypts its answer to it, so
                the reply is public bytes with private content — asking reveals that you asked,
                never what you were told.
              </p>

              {!disclosure ? (
                <>
                  <button className="wallet-btn" disabled={busy !== null} onClick={request}>
                    {busy === "disclose" ? "Waiting for the enclave…" : "Request my allocation"}
                  </button>
                  <p className="hint">
                    Stay on this page until the reply arrives. The decryption key exists only in this
                    tab and is never stored — leaving loses it, and you would have to ask again.
                  </p>
                </>
              ) : (
                <dl className="facts">
                  <div>
                    <dt>Your allocation</dt>
                    <dd>
                      <strong>{formatEther(BigInt(disclosure.amount))} C2FLR</strong>
                    </dd>
                  </div>
                  <div>
                    <dt>Index</dt>
                    <dd>{disclosure.index}</dd>
                  </div>
                  <div>
                    <dt>Proof</dt>
                    <dd>{disclosure.proof.length} sibling hashes</dd>
                  </div>
                </dl>
              )}
            </section>
          )}

          {disclosure && check && (
            <section className="step">
              <h2>2. Check it before you spend it</h2>
              <p className="why">
                The enclave told you a number. Rather than take its word, the proof is re-verified
                here against the root the contract actually holds.
              </p>

              <div className={`check ${check.rootMatches ? "pass" : "fail"}`}>
                <span className="mark">{check.rootMatches ? "PASS" : "FAIL"}</span>
                <span className="label">The root it quoted is the root on-chain</span>
                <span className="value">
                  <code>{round.merkleRoot}</code>
                </span>
              </div>

              <div className={`check ${check.proofValid ? "pass" : "fail"}`}>
                <span className="mark">{check.proofValid ? "PASS" : "FAIL"}</span>
                <span className="label">The proof reaches that root from your leaf</span>
                <span className="value">
                  Recomputed in this browser, independently of the contract.
                </span>
              </div>
            </section>
          )}

          {disclosure && check?.ok && (
            <section className="step">
              <h2>3. Claim</h2>

              <div className="callout warn">
                <strong>Claiming makes your amount public.</strong> The transaction emits{" "}
                <code>AllocationClaimed</code> with the amount in the clear, so from this point
                anyone can see what you received. That is inherent — money that moves cannot also be
                invisible — and it is your decision, not a side effect.
              </div>

              {claimed ? (
                <div className="callout pass">
                  <strong>Claimed.</strong> {formatAmount(BigInt(disclosure.amount))} C2FLR has been
                  transferred to you.
                </div>
              ) : round.status !== FINALIZED ? (
                <div className="callout unknown">
                  The round is not finalized yet, so claims are not open. Someone must relay the
                  signed result first — anyone can, not only the organization.
                </div>
              ) : windowClosed ? (
                <div className="callout fail">
                  <strong>The claim window has closed.</strong> Unclaimed allocations return to the
                  organization when the round is closed.
                </div>
              ) : (
                <button className="wallet-btn" disabled={busy !== null} onClick={claim}>
                  {busy === "claim"
                    ? "Claiming…"
                    : `Claim ${formatEther(BigInt(disclosure.amount))} C2FLR`}
                </button>
              )}
            </section>
          )}

          {round.status >= FINALIZED && (
            <p className="hint">
              Anyone can audit this round without learning who got what —{" "}
              <Link href={`/verify/${roundId}`}>see the public verification report</Link>.
            </p>
          )}
        </>
      )}
    </>
  );
}
