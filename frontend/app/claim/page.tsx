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
 *
 * ## Eligibility
 *
 * Two different failures mean "you are not in this round": the enclave declining a disclosure
 * request, and `BadMerkleProof` on the claim itself. Both are surfaced as one plain sentence
 * rather than as a revert. See lib/errors.ts — `BadMerkleProof` is classified as an eligibility
 * problem for exactly this reason.
 */

"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { formatEther, decodeAbiParameters, parseEventLogs, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import { RequireWallet } from "@/components/Wallet";
import { Dialog, ErrorDialog } from "@/components/ui/Dialog";
import { IconCheck, IconLock } from "@/components/ui/Icons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  FIDENSUR_EVENTS_ABI,
  FIDENSUR_READ_ABI,
  FIDENSUR_WRITE_ABI,
  statusName,
  type Round,
} from "@/lib/contracts";
import { decryptDisclosure, generateDisclosureKeypair } from "@/lib/ecies";
import { humanizeError, type FriendlyError } from "@/lib/errors";
import { formatDateTime, formatTokenAmount } from "@/lib/format";
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
  // Two pieces of state, not one. `claimed` is permanent for this session — it disables the claim
  // button and swaps in the settled note. `celebrating` is just the dialog, which the user closes.
  // Collapsing them would mean dismissing the congratulation re-enables a button that can no
  // longer succeed.
  const [claimed, setClaimed] = useState<bigint | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<FriendlyError | null>(null);

  const guard = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setFailure(null);
    try {
      await fn();
    } catch (e) {
      setFailure(humanizeError(e));
    } finally {
      setBusy(null);
    }
  };

  const fetchRound = useCallback(
    async (id: bigint) =>
      (await publicClient!.readContract({
        address: contract,
        abi: FIDENSUR_READ_ABI,
        functionName: "getRound",
        args: [id],
      })) as Round,
    [publicClient, contract],
  );

  /**
   * Opens a round from the lookup box.
   *
   * Clears the disclosure and the claim state, because those belong to whichever round was open
   * before. Re-reading the *same* round after a claim must not go through here — it would discard
   * the disclosure and take the claim panel off screen before the recipient had seen it settle.
   */
  const load = useCallback(
    async (id: bigint) => {
      setBusy("load");
      setFailure(null);
      setDisclosure(null);
      setClaimed(null);
      setCelebrating(false);
      try {
        setRoundId(id);
        setRound(await fetchRound(id));
      } catch (e) {
        setFailure(humanizeError(e));
      } finally {
        setBusy(null);
      }
    },
    [fetchRound],
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
        // a quieter way to test whether an address is in the round. A refusal here almost always
        // means the caller is not a recipient, which is what the user is told.
        throw new EligibilityError(result.log);
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

  const claim = () =>
    guard("claim", async () => {
      if (!disclosure || roundId === null) throw new Error("no disclosure");
      const amount = BigInt(disclosure.amount);

      const { request: sim } = await publicClient!.simulateContract({
        address: contract,
        abi: FIDENSUR_WRITE_ABI,
        functionName: "claim",
        args: [roundId, BigInt(disclosure.index), amount, disclosure.proof],
        account: walletClient!.account,
      } as never);
      const hash = await walletClient!.writeContract(sim as never);
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("claim reverted");

      // `fetchRound`, not `load` — the disclosure and the settled panel must survive this.
      setRound(await fetchRound(roundId));
      setClaimed(amount);
      setCelebrating(true);
    });

  const check = disclosure && round ? checkDisclosure(disclosure, round.merkleRoot) : null;
  const windowClosed = round ? Math.floor(Date.now() / 1000) > round.claimDeadline : false;

  return (
    <>
      <section className="step">
        <h2 style={{ marginTop: 0 }}>Which round?</h2>
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
            placeholder="Round number"
            aria-label="Round number"
          />
          <button
            className="btn btn-primary"
            disabled={!/^\d+$/.test(lookup.trim()) || busy !== null}
            onClick={() => load(BigInt(lookup.trim()))}
          >
            {busy === "load" ? "Loading…" : "Load round"}
          </button>
        </div>
      </section>

      {round && roundId !== null && (
        <>
          <dl className="facts">
            <div>
              <dt>Round</dt>
              <dd>{String(roundId)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <StatusBadge status={round.status} />
              </dd>
            </div>
            <div>
              <dt>Recipients</dt>
              <dd>{round.recipientCount || "—"}</dd>
            </div>
            <div>
              <dt>Claim closes</dt>
              <dd>{round.claimDeadline ? formatDateTime(round.claimDeadline) : "not yet set"}</dd>
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
              <h2 style={{ marginTop: 0 }}>1. Ask what you were allocated</h2>
              <p className="why">
                A fresh keypair is generated in this tab. The enclave encrypts its answer to it, so
                the reply is public bytes with private content — asking reveals that you asked,
                never what you were told.
              </p>

              {!disclosure ? (
                <>
                  <button className="btn btn-primary" disabled={busy !== null} onClick={request}>
                    <IconLock size={15} />
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
                      <strong>{formatTokenAmount(BigInt(disclosure.amount))} C2FLR</strong>
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
              <h2 style={{ marginTop: 0 }}>2. Check it before you spend it</h2>
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
              <h2 style={{ marginTop: 0 }}>3. Claim</h2>

              {claimed !== null ? (
                <div className="panel-done">
                  <span className="done-mark" aria-hidden="true">
                    <IconCheck size={11} />
                  </span>
                  <div>
                    <strong>Claimed.</strong> {formatTokenAmount(claimed)} C2FLR has been
                    transferred to your wallet. Each allocation can only be claimed once.
                  </div>
                </div>
              ) : (
                <>
                  <div className="callout warn">
                    <strong>Claiming makes your amount public.</strong> The transaction emits{" "}
                    <code>AllocationClaimed</code> with the amount in the clear, so from this point
                    anyone can see what you received. That is inherent — money that moves cannot be
                    invisible — and it is your decision, not a side effect.
                  </div>

                  {round.status !== FINALIZED ? (
                    <div className="callout unknown">
                      The round is not finalized yet, so claims are not open. Someone must relay the
                      signed result first — anyone can, not only the organization.
                    </div>
                  ) : windowClosed ? (
                    <div className="callout fail">
                      <strong>The claim window has closed.</strong> Unclaimed allocations return to
                      the organization when the round is closed.
                    </div>
                  ) : (
                    <button className="btn btn-primary" disabled={busy !== null} onClick={claim}>
                      {busy === "claim"
                        ? "Claiming…"
                        : `Claim ${formatTokenAmount(BigInt(disclosure.amount))} C2FLR`}
                    </button>
                  )}
                </>
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

      <ErrorDialog error={failure} onClose={() => setFailure(null)} />

      <Dialog
        open={celebrating}
        tone="success"
        title="Allocation claimed"
        onClose={() => setCelebrating(false)}
        primary={{ label: "Done" }}
      >
        <p>
          <span className="dialog-amount">
            {claimed !== null ? formatTokenAmount(claimed) : ""}
            <span className="unit">C2FLR</span>
          </span>
          has been transferred to your wallet.
        </p>
        <p className="dialog-hint">
          Round {roundId !== null ? String(roundId) : ""} is settled for you. Nobody learned anyone
          else&rsquo;s allocation in the process.
        </p>
      </Dialog>
    </>
  );
}

/**
 * The enclave declining a disclosure request.
 *
 * A distinct type so `humanizeError` can say "you are not eligible for this round" rather than
 * relaying the enclave's own wording, which is written for an operator reading a log.
 */
class EligibilityError extends Error {
  constructor(log?: string) {
    super(log ?? "not a recipient of this round");
    this.name = "EligibilityError";
  }
}
