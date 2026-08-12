/**
 * Organization console.
 *
 * Drives one round through the contract's state machine: create → fund → commit → compute →
 * finalize. The page deliberately reads the round's status from the chain after every action rather
 * than tracking a local step counter, because the chain is the only account of where a round
 * actually is — a browser that missed a receipt would otherwise offer an action that must revert.
 *
 * ## The confidential path
 *
 * The plaintext policy exists only in this tab. It is ABI-encoded and ECIES-encrypted to the
 * enclave's public key here, and only the ciphertext is ever transmitted. There is no backend to
 * send it to, which is not an accident of architecture but the reason the claim holds.
 *
 * ## What this page will not let you skip
 *
 * Downloading the ciphertext before committing to it. See lib/vault.ts: `requestCompute` accepts
 * only bytes matching the on-chain commitment, and re-encrypting the same policy produces different
 * bytes because ECIES draws a fresh ephemeral key each time. Losing the file strands the round.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { parseEther, type Address, type Hex } from "viem";
import { usePublicClient, useWalletClient, useAccount } from "wagmi";

import { PolicyBuilder, type PolicyDraftResult } from "@/components/PolicyBuilder";
import { RequireWallet } from "@/components/Wallet";
import {
  COSTON2,
  FIDENSUR_READ_ABI,
  FIDENSUR_WRITE_ABI,
  NATIVE_TOKEN,
  formatAmount,
  statusName,
  type Round,
} from "@/lib/contracts";
import { randomSalt, sealPolicy, type Policy } from "@/lib/policy";
import { ProxyClient } from "@/lib/proxy";
import { downloadPolicy, loadPolicy, savePolicy, parsePolicyFile } from "@/lib/vault";
import { type ActionResult } from "@/lib/verify";

const CONTRACT = process.env.NEXT_PUBLIC_FIDENSUR_CONTRACT as Address | undefined;
const PROXY_URL = process.env.NEXT_PUBLIC_EXT_PROXY_URL;

/** Matches `opts.Value` in the Flare scaffold. Unused value is refunded to the caller. */
const INSTRUCTION_FEE = 1_000_000n;

/** Status values from `Fidensur.RoundStatus`. */
const OPEN = 1;
const COMMITTED = 2;
const COMPUTING = 3;
const FINALIZED = 4;

export default function OrgConsolePage() {
  return (
    // `div`, not `main`: AppShell supplies the page's single `main` landmark.
    <div className="console">
      <h1>Organization console</h1>
      <p className="tagline">
        Compose an allocation privately, commit to it publicly, and let a TEE do the arithmetic.
      </p>

      {!CONTRACT ? (
        <div className="callout fail">
          <strong>NEXT_PUBLIC_FIDENSUR_CONTRACT is not set.</strong> The console has no contract to
          talk to. Set it in the frontend environment and restart.
        </div>
      ) : (
        <RequireWallet>
          <Console contract={CONTRACT} />
        </RequireWallet>
      )}
    </div>
  );
}

function Console({ contract }: { contract: Address }) {
  const publicClient = usePublicClient();
  const { data: walletClient, isLoading: walletLoading, error: walletError } = useWalletClient();
  const { address, chainId } = useAccount();

  const [roundId, setRoundId] = useState<bigint | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const note = useCallback((message: string) => {
    setLog((prev) => [...prev, message]);
  }, []);

  const refresh = useCallback(async () => {
    if (!publicClient || roundId === null) return;
    const data = (await publicClient.readContract({
      address: contract,
      abi: FIDENSUR_READ_ABI,
      functionName: "getRound",
      args: [roundId],
    })) as Round;
    setRound(data);
  }, [publicClient, contract, roundId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Runs one on-chain action, holding the UI in a busy state and surfacing the revert reason.
   *
   * viem decodes custom errors only when they are present in the ABI, which is why
   * FIDENSUR_ERRORS_ABI is spread into every ABI in contracts.ts. Without it a failure here reads
   * "reverted with signature 0x6a4fd69d", which tells the user nothing.
   */
  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const send = useCallback(
    async (functionName: string, args: unknown[], value = 0n): Promise<Hex> => {
      // "wallet not ready" on its own is unactionable — it names a symptom and no cause, and
      // there are three quite different ones. Say which.
      if (!publicClient) {
        throw new Error(
          `No RPC client for chain ${chainId ?? "unknown"}. Fidensur is configured only for ` +
            `${COSTON2.name} (chain ${COSTON2.id}). Switch networks in your wallet.`,
        );
      }
      if (!walletClient) {
        if (walletLoading) throw new Error("The wallet is still connecting. Try again in a moment.");
        if (walletError) throw new Error(`The wallet refused to provide a signer: ${walletError.message}`);
        throw new Error(
          `No signer available. The wallet reports chain ${chainId ?? "unknown"}; Fidensur ` +
            `expects ${COSTON2.id}. If your wallet is already on ${COSTON2.name}, reload the ` +
            `page — a network switched after connecting is not always propagated.`,
        );
      }
      const { request } = await publicClient.simulateContract({
        address: contract,
        abi: FIDENSUR_WRITE_ABI,
        functionName,
        args,
        account: walletClient.account,
        value,
      } as never);
      const hash = await walletClient.writeContract(request as never);
      note(`${functionName}: ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
      return hash;
    },
    [publicClient, walletClient, walletLoading, walletError, chainId, contract, note],
  );

  const isOrganization =
    round && address ? round.organization.toLowerCase() === address.toLowerCase() : true;

  return (
    <>
      <RoundPicker
        contract={contract}
        roundId={roundId}
        onSelect={setRoundId}
        send={send}
        run={run}
        busy={busy}
        note={note}
      />

      {error && (
        <div className="callout fail">
          <strong>Transaction failed.</strong>
          <pre>
            <code>{error}</code>
          </pre>
        </div>
      )}

      {round && roundId !== null && (
        <>
          <RoundFacts roundId={roundId} round={round} />

          {!isOrganization && (
            <div className="callout warn">
              <strong>You are not this round&rsquo;s organization.</strong> It belongs to{" "}
              <code>{round.organization}</code>. Only that account can fund, commit, or request a
              computation.
            </div>
          )}

          {round.status === OPEN && (
            <>
              <FundStep roundId={roundId} round={round} send={send} run={run} busy={busy} />
              {round.funded > 0n && address && (
                <CommitStep
                  contract={contract}
                  roundId={roundId}
                  organization={address}
                  send={send}
                  run={run}
                  busy={busy}
                  note={note}
                />
              )}
            </>
          )}

          {round.status === COMMITTED && (
            <ComputeStep roundId={roundId} round={round} send={send} run={run} busy={busy} />
          )}

          {round.status === COMPUTING && (
            <FinalizeStep roundId={roundId} round={round} send={send} run={run} busy={busy} note={note} />
          )}

          {round.status >= FINALIZED && (
            <section className="step">
              <h2>Done</h2>
              <div className="callout pass">
                <strong>Round {String(roundId)} is {statusName(round.status).toLowerCase()}.</strong>{" "}
                The chain now holds a Merkle root, a total and a count — and no individual
                allocation.
              </div>
              <p>
                <Link href={`/verify/${roundId}`}>Open the public verification report →</Link>
              </p>
              <p className="hint">
                Recipients can now request a disclosure and claim from the{" "}
                <Link href="/claim">claim page</Link>. Tell them the round number; they need nothing
                else from you.
              </p>
            </section>
          )}
        </>
      )}

      {log.length > 0 && (
        <section className="step">
          <h2>Activity</h2>
          <pre>
            <code>{log.join("\n")}</code>
          </pre>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function RoundPicker({
  contract,
  roundId,
  onSelect,
  send,
  run,
  busy,
  note,
}: {
  contract: Address;
  roundId: bigint | null;
  onSelect: (id: bigint) => void;
  send: (fn: string, args: unknown[], value?: bigint) => Promise<Hex>;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  busy: string | null;
  note: (m: string) => void;
}) {
  const publicClient = usePublicClient();
  const [days, setDays] = useState("7");
  const [lookup, setLookup] = useState("");

  const create = () =>
    run("create", async () => {
      const seconds = BigInt(Math.round(Number(days) * 86_400));
      // Mirrors MIN_CLAIM_WINDOW (1 hour) and MAX_CLAIM_WINDOW (365 days) in Fidensur.sol. Checking
      // here turns a wasted transaction and an InvalidClaimWindow revert into a sentence.
      if (!Number.isFinite(Number(days))) throw new Error("claim window must be a number");
      if (seconds < 3_600n) throw new Error("claim window must be at least 1 hour (0.042 days)");
      if (seconds > 31_536_000n) throw new Error("claim window must be at most 365 days");

      // Read nextRoundId first: createRound returns the id, but a transaction receipt carries logs
      // rather than return values, and reading the counter before the call is simpler than decoding
      // RoundCreated out of the receipt.
      const next = (await publicClient!.readContract({
        address: contract,
        abi: FIDENSUR_READ_ABI,
        functionName: "nextRoundId",
      })) as bigint;

      await send("createRound", [NATIVE_TOKEN, seconds]);
      note(`round ${next} created`);
      onSelect(next);
    });

  return (
    <section className="step">
      <h2>Round</h2>
      <div className="field-row">
        <div className="field-group">
          <label className="label" htmlFor="days">
            Claim window (days)
          </label>
          <input
            id="days"
            className="text-input"
            inputMode="decimal"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
          <p className="hint">
            After this expires, anyone can close the round and return everything unclaimed to you.
          </p>
        </div>
        <div className="field-group">
          <label className="label">&nbsp;</label>
          <button className="wallet-btn" onClick={create} disabled={busy !== null}>
            {busy === "create" ? "Creating…" : "Create a round"}
          </button>
        </div>
      </div>

      <div className="field-row">
        <div className="field-group">
          <label className="label" htmlFor="lookup">
            …or open an existing round
          </label>
          <div className="lookup">
            <input
              id="lookup"
              className="text-input"
              inputMode="numeric"
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              placeholder="round number"
            />
            <button
              className="wallet-btn"
              disabled={!/^\d+$/.test(lookup.trim())}
              onClick={() => onSelect(BigInt(lookup.trim()))}
            >
              Open
            </button>
          </div>
        </div>
      </div>

      {roundId !== null && <p className="hint">Working on round {String(roundId)}.</p>}
    </section>
  );
}

function RoundFacts({ roundId, round }: { roundId: bigint; round: Round }) {
  return (
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
        <dt>Token</dt>
        <dd>{round.token === NATIVE_TOKEN ? "C2FLR (native)" : <code>{round.token}</code>}</dd>
      </div>
      <div>
        <dt>Funded</dt>
        <dd>{formatAmount(round.funded)} C2FLR</dd>
      </div>
      {round.status >= FINALIZED && (
        <>
          <div>
            <dt>Allocated</dt>
            <dd>{formatAmount(round.totalAllocated)} C2FLR</dd>
          </div>
          <div>
            <dt>Recipients</dt>
            <dd>{round.recipientCount}</dd>
          </div>
        </>
      )}
    </dl>
  );
}

function FundStep({
  roundId,
  round,
  send,
  run,
  busy,
}: {
  roundId: bigint;
  round: Round;
  send: (fn: string, args: unknown[], value?: bigint) => Promise<Hex>;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  busy: string | null;
}) {
  const [amount, setAmount] = useState("");

  const valid = /^\d+(\.\d+)?$/.test(amount.trim()) && Number(amount) > 0;

  return (
    <section className="step">
      <h2>1. Fund the round</h2>
      <p className="why">
        The contract must hold the money before it can promise it. Funding is separate from the
        policy on purpose — the amount is public, the split is not.
      </p>
      <div className="lookup">
        <input
          className="text-input"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="amount in C2FLR"
        />
        <button
          className="wallet-btn"
          disabled={!valid || busy !== null}
          onClick={() =>
            run("fund", async () => {
              const wei = parseEther(amount.trim());
              await send("fund", [roundId, wei], wei);
              setAmount("");
            })
          }
        >
          {busy === "fund" ? "Funding…" : "Fund"}
        </button>
      </div>
      {round.funded > 0n && (
        <p className="hint">
          Currently funded: {formatAmount(round.funded)} C2FLR. You can add more, or commit a policy
          below.
        </p>
      )}
    </section>
  );
}

function CommitStep({
  contract,
  roundId,
  organization,
  send,
  run,
  busy,
  note,
}: {
  contract: Address;
  roundId: bigint;
  organization: Address;
  send: (fn: string, args: unknown[], value?: bigint) => Promise<Hex>;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  busy: string | null;
  note: (m: string) => void;
}) {
  const [draft, setDraft] = useState<PolicyDraftResult | null>(null);
  const [sealed, setSealed] = useState<{ ciphertext: Hex; commitment: Hex } | null>(null);
  const [saved, setSaved] = useState(false);

  const ready =
    draft !== null &&
    draft.entries.length > 0 &&
    draft.parseErrors.length === 0 &&
    draft.validation.ok;

  const seal = () =>
    run("seal", async () => {
      if (!PROXY_URL) throw new Error("NEXT_PUBLIC_EXT_PROXY_URL is not set");
      if (!draft) throw new Error("no policy");

      // The enclave's public key comes from the proxy's attestation report, live. Hard-coding it
      // would survive a TEE re-registration and silently encrypt to a key nobody holds any more.
      const teePubKey = await new ProxyClient(PROXY_URL).extensionPublicKey();

      const policy: Policy = {
        contractAddr: contract,
        roundId,
        organization,
        mode: draft.mode,
        totalBudget: draft.totalBudget,
        minAlloc: draft.minAlloc,
        maxAlloc: draft.maxAlloc,
        bands: draft.bands,
        salt: randomSalt(),
        entries: draft.entries,
      };

      const result = await sealPolicy(policy, teePubKey);
      savePolicy({ roundId: String(roundId), commitment: result.commitment, ciphertext: result.ciphertext });
      setSealed(result);
      note(`sealed: ${result.commitment}`);
    });

  return (
    <section className="step">
      <h2>2. Compose and commit the policy</h2>
      <p className="why">
        This is the only place the plaintext exists. It is encrypted in this tab and never
        transmitted; the chain records nothing but a hash of the ciphertext.
      </p>

      <PolicyBuilder
        contractAddr={contract}
        roundId={roundId}
        organization={organization}
        onChange={setDraft}
      />

      {!sealed ? (
        <button className="wallet-btn" disabled={!ready || busy !== null} onClick={seal}>
          {busy === "seal" ? "Encrypting…" : "Encrypt policy"}
        </button>
      ) : (
        <>
          <dl className="facts">
            <div>
              <dt>Commitment</dt>
              <dd>
                <code>{sealed.commitment}</code>
              </dd>
            </div>
            <div>
              <dt>Ciphertext</dt>
              <dd>{(sealed.ciphertext.length - 2) / 2} bytes</dd>
            </div>
          </dl>

          <div className="callout warn">
            <strong>Save the ciphertext before committing.</strong> Only these exact bytes can
            advance the round: encrypting the same policy again draws a new ephemeral key and
            produces a different ciphertext with a different hash, which the contract rejects. Lose
            the file and the round can never be computed.
            <div style={{ marginTop: "0.75rem" }}>
              <button
                className="wallet-btn"
                onClick={() => {
                  downloadPolicy({
                    roundId: String(roundId),
                    commitment: sealed.commitment,
                    ciphertext: sealed.ciphertext,
                  });
                  setSaved(true);
                }}
              >
                Download ciphertext
              </button>
            </div>
          </div>

          <button
            className="wallet-btn"
            disabled={!saved || busy !== null}
            onClick={() =>
              run("commit", async () => {
                await send("submitPolicy", [roundId, sealed.commitment]);
              })
            }
          >
            {busy === "commit" ? "Committing…" : "Commit on-chain"}
          </button>
          {!saved && <p className="hint">Download the ciphertext to enable this.</p>}
        </>
      )}
    </section>
  );
}

function ComputeStep({
  roundId,
  round,
  send,
  run,
  busy,
}: {
  roundId: bigint;
  round: Round;
  send: (fn: string, args: unknown[], value?: bigint) => Promise<Hex>;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  busy: string | null;
}) {
  const stored = useMemo(() => loadPolicy(roundId), [roundId]);
  const [uploaded, setUploaded] = useState<Hex | null>(null);

  const ciphertext = uploaded ?? (stored?.ciphertext as Hex | undefined) ?? null;
  const matches = ciphertext !== null && stored?.commitment === round.policyCommitment;

  return (
    <section className="step">
      <h2>3. Request the computation</h2>
      <p className="why">
        The ciphertext goes on-chain here, addressed to the enclave. Anyone can read those bytes;
        only the TEE holds the key that makes them mean anything.
      </p>

      {!ciphertext ? (
        <div className="callout warn">
          <strong>This browser does not have the ciphertext for round {String(roundId)}.</strong>{" "}
          Upload the file you downloaded when you committed.
          <div style={{ marginTop: "0.75rem" }}>
            <input
              type="file"
              accept=".txt,text/plain"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const parsed = parsePolicyFile(await file.text());
                if (parsed) setUploaded(parsed);
              }}
            />
          </div>
        </div>
      ) : (
        <>
          <dl className="facts">
            <div>
              <dt>On-chain commitment</dt>
              <dd>
                <code>{round.policyCommitment}</code>
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{uploaded ? "uploaded file" : "this browser"}</dd>
            </div>
          </dl>
          {!matches && !uploaded && (
            <div className="callout warn">
              The stored ciphertext does not match the commitment on-chain. Upload the correct file
              instead — <code>requestCompute</code> will reject a mismatch.
            </div>
          )}
          <button
            className="wallet-btn"
            disabled={busy !== null}
            onClick={() =>
              run("compute", async () => {
                await send("requestCompute", [roundId, ciphertext], INSTRUCTION_FEE);
              })
            }
          >
            {busy === "compute" ? "Sending…" : "Request computation"}
          </button>
        </>
      )}
    </section>
  );
}

function FinalizeStep({
  roundId,
  round,
  send,
  run,
  busy,
  note,
}: {
  roundId: bigint;
  round: Round;
  send: (fn: string, args: unknown[], value?: bigint) => Promise<Hex>;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  busy: string | null;
  note: (m: string) => void;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [polling, setPolling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const poll = async () => {
    if (!PROXY_URL) {
      setProblem("NEXT_PUBLIC_EXT_PROXY_URL is not set");
      return;
    }
    setPolling(true);
    setProblem(null);
    try {
      const found = await new ProxyClient(PROXY_URL).waitForResult(round.computeInstructionId, {
        timeoutMs: 240_000,
        intervalMs: 5_000,
      });
      if (found.status !== 1) {
        // The log is the enclave's own account of the refusal, and the only one there is.
        setProblem(`The enclave rejected the instruction: ${found.log ?? "(no reason given)"}`);
        return;
      }
      setResult(found);
      note(`result ready for ${round.computeInstructionId}`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setPolling(false);
    }
  };

  return (
    <section className="step">
      <h2>4. Collect and relay the result</h2>
      <p className="why">
        The enclave signs its answer; the chain verifies that signature. Relaying is permissionless —
        anyone holding the signed result can submit it, so you cannot suppress an outcome you dislike
        by declining to send this transaction.
      </p>

      <dl className="facts">
        <div>
          <dt>Instruction</dt>
          <dd>
            <code>{round.computeInstructionId}</code>
          </dd>
        </div>
      </dl>

      {problem && (
        <div className="callout fail">
          <strong>No usable result.</strong>
          <p>{problem}</p>
          <p className="hint">
            If the TEE never answers, <code>requestCompute</code> can be retried after 30 minutes
            with the same ciphertext.
          </p>
        </div>
      )}

      {!result ? (
        <button className="wallet-btn" disabled={polling} onClick={poll}>
          {polling ? "Waiting for the enclave…" : "Check for the result"}
        </button>
      ) : (
        <>
          <div className="callout pass">
            <strong>Signed result received.</strong> The contract will re-derive the same hash and
            recover the signer before accepting it.
          </div>
          <button
            className="wallet-btn"
            disabled={busy !== null}
            onClick={() =>
              run("finalize", async () => {
                await send("finalizeRound", [
                  result.data,
                  result.actionId,
                  result.submissionTag,
                  result.status,
                  result.signature,
                ]);
              })
            }
          >
            {busy === "finalize" ? "Finalizing…" : "Finalize round"}
          </button>
        </>
      )}
    </section>
  );
}
