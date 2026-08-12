/**
 * Organization console.
 *
 * Drives one round through the contract's state machine: create → fund → commit → compute →
 * finalize, as a five-step flow showing one step at a time.
 *
 * ## The step is derived, never counted
 *
 * `stepForRound()` computes which step a round has reached purely from its on-chain status. There
 * is no local step counter, because the chain is the only account of where a round actually is —
 * a browser that missed a receipt would otherwise keep offering an action that must revert. The
 * viewing position is separate state, and is clamped to the derived step after every refresh, so
 * a completed action always advances the view and a stale tab corrects itself.
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
 * only bytes matching the on-chain commitment, and re-encrypting the same policy produces
 * different bytes because ECIES draws a fresh ephemeral key each time. Losing the file strands
 * the round.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseEther, type Address, type Hex } from "viem";
import { usePublicClient, useWalletClient, useAccount } from "wagmi";

import { PolicyBuilder, type PolicyDraftResult } from "@/components/PolicyBuilder";
import { RequireWallet } from "@/components/Wallet";
import { Stepper } from "@/components/app/Stepper";
import { Dialog, ErrorDialog } from "@/components/ui/Dialog";
import {
  IconArrowRight,
  IconCheck,
  IconChevronRight,
  IconLock,
  IconShieldCheck,
} from "@/components/ui/Icons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  COSTON2,
  FIDENSUR_READ_ABI,
  FIDENSUR_WRITE_ABI,
  NATIVE_TOKEN,
  type Round,
} from "@/lib/contracts";
import { humanizeError, type FriendlyError } from "@/lib/errors";
import { formatTokenAmount } from "@/lib/format";
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

/** Mirrors MIN_CLAIM_WINDOW / MAX_CLAIM_WINDOW in Fidensur.sol. */
const MIN_WINDOW_SECONDS = 3_600n;
const MAX_WINDOW_SECONDS = 31_536_000n;

type Step = 0 | 1 | 2 | 3 | 4;

/**
 * Which step a round has reached, from chain status alone.
 *
 * Funding is step 1 but is not a status of its own — a round stays `Open` whether or not it holds
 * money — so it is decided by the balance rather than the enum.
 */
function stepForRound(round: Round | null): Step {
  if (!round) return 0;
  if (round.status >= FINALIZED) return 4;
  if (round.status === COMPUTING) return 3;
  if (round.status === COMMITTED) return 3;
  if (round.status === OPEN) return round.funded > 0n ? 2 : 1;
  return 0;
}

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
  const [failure, setFailure] = useState<FriendlyError | null>(null);
  const [success, setSuccess] = useState<{ title: string; body: React.ReactNode } | null>(null);

  // Where the user is looking. Clamped to the round's real progress after every read, so a
  // completed action always carries the view forward.
  const [viewing, setViewing] = useState<Step>(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const previousStep = useRef<Step>(0);

  const reached = stepForRound(round);

  const refresh = useCallback(async () => {
    if (!publicClient || roundId === null) return;
    const data = (await publicClient.readContract({
      address: contract,
      abi: FIDENSUR_READ_ABI,
      functionName: "getRound",
      args: [roundId],
    })) as Round;
    setRound(data);
    setViewing(stepForRound(data));
  }, [publicClient, contract, roundId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Slide direction is whichever way the step number moved.
  useEffect(() => {
    setDirection(viewing >= previousStep.current ? "forward" : "back");
    previousStep.current = viewing;
  }, [viewing]);

  /**
   * Runs one action, holding the UI busy and translating any failure into a sentence.
   *
   * viem decodes custom errors only when they are present in the ABI, which is why
   * FIDENSUR_ERRORS_ABI is spread into every ABI in contracts.ts. Without it, `humanizeError`
   * would have nothing but a four-byte selector to work with.
   */
  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      setFailure(null);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setFailure(humanizeError(e));
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
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
      return hash;
    },
    [publicClient, walletClient, walletLoading, walletError, chainId, contract],
  );

  const isOrganization =
    round && address ? round.organization.toLowerCase() === address.toLowerCase() : true;

  const shared = { send, run, busy, setSuccess } as const;

  return (
    <>
      {roundId === null || !round ? (
        <CreateRound
          contract={contract}
          onOpened={(id) => {
            setRoundId(id);
            setViewing(0);
          }}
          run={run}
          send={send}
          busy={busy}
        />
      ) : (
        <>
          <RoundHeader roundId={roundId} round={round} onClose={() => {
            setRoundId(null);
            setRound(null);
          }} />

          <Stepper current={viewing} furthest={reached} onSelect={(s) => setViewing(s as Step)} />

          {!isOrganization && (
            <div className="callout warn">
              <strong>You are not this round&rsquo;s organization.</strong> It belongs to{" "}
              <code>{round.organization}</code>. Only that account can fund, commit, or request a
              computation.
            </div>
          )}

          <div className="wizard">
            <div className="wizard-panel" data-direction={direction} key={viewing}>
              {viewing === 0 && <CreatedPanel roundId={roundId} round={round} onNext={() => setViewing(1)} />}
              {viewing === 1 && (
                <FundPanel roundId={roundId} round={round} reached={reached} {...shared} onNext={() => setViewing(2)} />
              )}
              {viewing === 2 && address && (
                <PolicyPanel
                  contract={contract}
                  roundId={roundId}
                  round={round}
                  organization={address}
                  {...shared}
                />
              )}
              {viewing === 3 && <ComputePanel roundId={roundId} round={round} {...shared} />}
              {viewing === 4 && <SettledPanel roundId={roundId} round={round} />}
            </div>
          </div>
        </>
      )}

      <ErrorDialog error={failure} onClose={() => setFailure(null)} />

      <Dialog
        open={success !== null}
        tone="success"
        title={success?.title ?? ""}
        onClose={() => setSuccess(null)}
        primary={{ label: "Continue" }}
      >
        {success?.body}
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ create */

function CreateRound({
  contract,
  onOpened,
  run,
  send,
  busy,
}: {
  contract: Address;
  onOpened: (id: bigint) => void;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  send: (fn: string, args: unknown[], value?: bigint) => Promise<Hex>;
  busy: string | null;
}) {
  const publicClient = usePublicClient();
  const [days, setDays] = useState("7");
  const [custom, setCustom] = useState(false);
  const [lookup, setLookup] = useState("");

  const presets = ["7", "14", "30"];

  const create = () =>
    run("create", async () => {
      const value = Number(days);
      if (!Number.isFinite(value)) throw new Error("The claim window must be a number of days.");
      const seconds = BigInt(Math.round(value * 86_400));
      if (seconds < MIN_WINDOW_SECONDS) {
        throw new Error("The claim window must be at least 1 hour (0.042 days).");
      }
      if (seconds > MAX_WINDOW_SECONDS) {
        throw new Error("The claim window must be at most 365 days.");
      }

      // Read nextRoundId first: createRound returns the id, but a receipt carries logs rather than
      // return values, and reading the counter beforehand is simpler than decoding RoundCreated.
      const next = (await publicClient!.readContract({
        address: contract,
        abi: FIDENSUR_READ_ABI,
        functionName: "nextRoundId",
      })) as bigint;

      await send("createRound", [NATIVE_TOKEN, seconds]);
      onOpened(next);
    });

  return (
    <section className="create-card">
      <div className="create-head">
        <span className="create-icon" aria-hidden="true">
          <IconShieldCheck size={20} />
        </span>
        <div>
          <h2>Start an allocation round</h2>
          <p>
            A round holds the funds and the commitment. Nothing about who gets what is decided
            here — that comes later, encrypted, and never touches this page in the clear.
          </p>
        </div>
      </div>

      <div>
        <span className="field-label" id="window-label">
          Claim window
        </span>
        <div className="segmented" role="group" aria-labelledby="window-label">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={!custom && days === preset}
              onClick={() => {
                setCustom(false);
                setDays(preset);
              }}
            >
              {preset} days
            </button>
          ))}
          <button type="button" aria-pressed={custom} onClick={() => setCustom(true)}>
            Custom
          </button>
        </div>

        {custom && (
          <div style={{ marginTop: "var(--s3)", maxWidth: "12rem" }}>
            <input
              className="text-input"
              inputMode="decimal"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              aria-label="Claim window in days"
              placeholder="days"
            />
          </div>
        )}

        <p className="hint">
          After this expires, anyone can close the round and return everything unclaimed to you.
          Between 1 hour and 365 days.
        </p>
      </div>

      <div className="panel-actions">
        <button className="btn btn-primary" onClick={create} disabled={busy !== null}>
          {busy === "create" ? "Creating…" : "Create round"}
          {busy !== "create" && <IconArrowRight size={15} className="btn-arrow" />}
        </button>
      </div>

      <div className="create-divider">or continue an existing round</div>

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
          className="btn btn-secondary"
          disabled={!/^\d+$/.test(lookup.trim())}
          onClick={() => onOpened(BigInt(lookup.trim()))}
        >
          Open
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ header */

function RoundHeader({
  roundId,
  round,
  onClose,
}: {
  roundId: bigint;
  round: Round;
  onClose: () => void;
}) {
  return (
    <div className="page-head" style={{ marginBottom: "var(--s6)" }}>
      <div>
        <h2 style={{ fontSize: "1.375rem", margin: 0 }}>Round {String(roundId)}</h2>
        <p style={{ margin: "var(--s2) 0 0", display: "flex", gap: "var(--s3)", alignItems: "center" }}>
          <StatusBadge status={round.status} />
          <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-meta)" }}>
            {formatTokenAmount(round.funded)} C2FLR funded
          </span>
        </p>
      </div>
      <button className="btn btn-ghost btn-sm" onClick={onClose}>
        Switch round
      </button>
    </div>
  );
}

function PanelHead({ title, why }: { title: string; why: string }) {
  return (
    <>
      <h2 style={{ margin: "0 0 var(--s2)", fontSize: "1.15rem" }}>{title}</h2>
      <p className="why">{why}</p>
    </>
  );
}

function DoneNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="panel-done">
      <span className="done-mark" aria-hidden="true">
        <IconCheck size={11} />
      </span>
      <div>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------- steps */

function CreatedPanel({
  roundId,
  round,
  onNext,
}: {
  roundId: bigint;
  round: Round;
  onNext: () => void;
}) {
  return (
    <section className="step">
      <PanelHead
        title="Round created"
        why="The token and the claim window are fixed on-chain. Everything after this point is about what goes into the round, and who it comes out to."
      />

      <dl className="facts">
        <div>
          <dt>Round</dt>
          <dd>{String(roundId)}</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd>{round.token === NATIVE_TOKEN ? "C2FLR (native)" : <code>{round.token}</code>}</dd>
        </div>
        <div>
          <dt>Claim window</dt>
          <dd>{(round.claimWindow / 86_400).toFixed(2)} days</dd>
        </div>
        <div>
          <dt>Organization</dt>
          <dd>
            <code>{round.organization}</code>
          </dd>
        </div>
      </dl>

      <div className="panel-actions">
        <button className="btn btn-primary spacer" onClick={onNext}>
          Continue
          <IconChevronRight size={15} />
        </button>
      </div>
    </section>
  );
}

function FundPanel({
  roundId,
  round,
  reached,
  send,
  run,
  busy,
  setSuccess,
  onNext,
}: {
  roundId: bigint;
  round: Round;
  reached: Step;
  send: (fn: string, args: unknown[], value?: bigint) => Promise<Hex>;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  busy: string | null;
  setSuccess: (s: { title: string; body: React.ReactNode } | null) => void;
  onNext: () => void;
}) {
  const [amount, setAmount] = useState("");
  const valid = /^\d+(\.\d+)?$/.test(amount.trim()) && Number(amount) > 0;
  const canEdit = round.status === OPEN;

  return (
    <section className="step">
      <PanelHead
        title="Fund the treasury"
        why="The contract must hold the money before it can promise it. Funding is separate from the policy on purpose — the amount is public, the split is not."
      />

      {round.funded > 0n && (
        <DoneNote>
          <strong>{formatTokenAmount(round.funded)} C2FLR is held by this round.</strong> You can add
          more while it is still open.
        </DoneNote>
      )}

      {canEdit && (
        <div className="lookup" style={{ marginTop: "var(--s5)" }}>
          <input
            className="text-input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount in C2FLR"
            aria-label="Amount to fund in C2FLR"
          />
          <button
            className="btn btn-primary"
            disabled={!valid || busy !== null}
            onClick={() =>
              run("fund", async () => {
                const wei = parseEther(amount.trim());
                await send("fund", [roundId, wei], wei);
                setAmount("");
                setSuccess({
                  title: "Treasury funded",
                  body: (
                    <p>
                      <span className="dialog-amount">
                        {formatTokenAmount(wei)}
                        <span className="unit">C2FLR</span>
                      </span>
                      is now held by round {String(roundId)}.
                    </p>
                  ),
                });
              })
            }
          >
            {busy === "fund" ? "Funding…" : "Fund round"}
          </button>
        </div>
      )}

      <div className="panel-actions">
        <button
          className="btn btn-primary spacer"
          disabled={reached < 2}
          onClick={onNext}
          title={reached < 2 ? "Fund the round to continue" : undefined}
        >
          Continue
          <IconChevronRight size={15} />
        </button>
      </div>
    </section>
  );
}

function PolicyPanel({
  contract,
  roundId,
  round,
  organization,
  send,
  run,
  busy,
  setSuccess,
}: {
  contract: Address;
  roundId: bigint;
  round: Round;
  organization: Address;
  send: (fn: string, args: unknown[], value?: bigint) => Promise<Hex>;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  busy: string | null;
  setSuccess: (s: { title: string; body: React.ReactNode } | null) => void;
}) {
  const [draft, setDraft] = useState<PolicyDraftResult | null>(null);
  const [sealed, setSealed] = useState<{ ciphertext: Hex; commitment: Hex } | null>(null);
  const [saved, setSaved] = useState(false);

  // Already committed: there is nothing to compose, and re-showing the builder would invite
  // someone to author a policy that can no longer be submitted.
  if (round.status >= COMMITTED) {
    return (
      <section className="step">
        <PanelHead
          title="Policy committed"
          why="The chain records a hash of the ciphertext and nothing else. It binds this round to one exact policy without revealing a line of it."
        />
        <DoneNote>
          <strong>Committed.</strong> The policy for this round is fixed and cannot be changed.
        </DoneNote>
        <dl className="facts">
          <div>
            <dt>Commitment</dt>
            <dd>
              <code>{round.policyCommitment}</code>
            </dd>
          </div>
        </dl>
      </section>
    );
  }

  const ready =
    draft !== null &&
    draft.entries.length > 0 &&
    draft.parseErrors.length === 0 &&
    draft.validation.ok;

  const seal = () =>
    run("seal", async () => {
      if (!PROXY_URL) throw new Error("NEXT_PUBLIC_EXT_PROXY_URL is not set");
      if (!draft) throw new Error("No policy has been composed yet.");

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
      savePolicy({
        roundId: String(roundId),
        commitment: result.commitment,
        ciphertext: result.ciphertext,
      });
      setSealed(result);
    });

  return (
    <section className="step">
      <PanelHead
        title="Compose and commit the policy"
        why="This is the only place the plaintext exists. It is encrypted in this tab and never transmitted; the chain records nothing but a hash of the ciphertext."
      />

      {!sealed ? (
        <>
          <PolicyBuilder
            contractAddr={contract}
            roundId={roundId}
            organization={organization}
            onChange={setDraft}
          />
          <div className="panel-actions">
            <button className="btn btn-primary spacer" disabled={!ready || busy !== null} onClick={seal}>
              <IconLock size={15} />
              {busy === "seal" ? "Encrypting…" : "Encrypt policy"}
            </button>
          </div>
        </>
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
            <div style={{ marginTop: "var(--s3)" }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  downloadPolicy({
                    roundId: String(roundId),
                    commitment: sealed.commitment,
                    ciphertext: sealed.ciphertext,
                  });
                  setSaved(true);
                }}
              >
                {saved ? "Download again" : "Download ciphertext"}
              </button>
            </div>
          </div>

          <div className="panel-actions">
            {!saved && <span className="hint">Download the ciphertext to enable committing.</span>}
            <button
              className="btn btn-primary spacer"
              disabled={!saved || busy !== null}
              onClick={() =>
                run("commit", async () => {
                  await send("submitPolicy", [roundId, sealed.commitment]);
                  setSuccess({
                    title: "Policy committed",
                    body: (
                      <p>
                        Round {String(roundId)} is now bound to one exact policy. The chain holds a
                        hash of it and nothing more.
                      </p>
                    ),
                  });
                })
              }
            >
              {busy === "commit" ? "Committing…" : "Commit on-chain"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function ComputePanel({
  roundId,
  round,
  send,
  run,
  busy,
  setSuccess,
}: {
  roundId: bigint;
  round: Round;
  send: (fn: string, args: unknown[], value?: bigint) => Promise<Hex>;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  busy: string | null;
  setSuccess: (s: { title: string; body: React.ReactNode } | null) => void;
}) {
  const stored = useMemo(() => loadPolicy(roundId), [roundId]);
  const [uploaded, setUploaded] = useState<Hex | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [polling, setPolling] = useState(false);
  const [problem, setProblem] = useState<FriendlyError | null>(null);

  const ciphertext = uploaded ?? (stored?.ciphertext as Hex | undefined) ?? null;
  const matches = ciphertext !== null && stored?.commitment === round.policyCommitment;

  // ---- dispatch ----
  if (round.status === COMMITTED) {
    return (
      <section className="step">
        <PanelHead
          title="Request the computation"
          why="The ciphertext goes on-chain here, addressed to the enclave. Anyone can read those bytes; only the TEE holds the key that makes them mean anything."
        />

        {!ciphertext ? (
          <div className="callout warn">
            <strong>This browser does not have the ciphertext for round {String(roundId)}.</strong>{" "}
            Upload the file you downloaded when you committed.
            <div style={{ marginTop: "var(--s3)" }}>
              <input
                type="file"
                accept=".txt,text/plain"
                aria-label="Ciphertext file"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const parsed = parsePolicyFile(await file.text());
                  if (parsed) setUploaded(parsed);
                  else
                    setProblem({
                      kind: "unknown",
                      title: "That file wasn't readable",
                      detail: "It doesn't contain a Fidensur ciphertext in the expected format.",
                      hint: "Use the .txt file downloaded at the commit step, unedited.",
                    });
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
                <dt>Ciphertext source</dt>
                <dd>{uploaded ? "uploaded file" : "this browser"}</dd>
              </div>
            </dl>

            {!matches && !uploaded && (
              <div className="callout warn">
                The stored ciphertext does not match the commitment on-chain. Upload the correct
                file instead — the contract will reject a mismatch.
              </div>
            )}

            <div className="panel-actions">
              <button
                className="btn btn-primary spacer"
                disabled={busy !== null}
                onClick={() =>
                  run("compute", async () => {
                    await send("requestCompute", [roundId, ciphertext], INSTRUCTION_FEE);
                    setSuccess({
                      title: "Sent to the enclave",
                      body: (
                        <p>
                          The ciphertext is on its way. Come back to this step to collect the signed
                          result — it usually takes under a minute.
                        </p>
                      ),
                    });
                  })
                }
              >
                {busy === "compute" ? "Sending…" : "Request computation"}
              </button>
            </div>
          </>
        )}

        <ErrorDialog error={problem} onClose={() => setProblem(null)} />
      </section>
    );
  }

  // ---- collect and relay ----
  const poll = async () => {
    if (!PROXY_URL) {
      setProblem(humanizeError(new Error("NEXT_PUBLIC_EXT_PROXY_URL is not set")));
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
        setProblem(humanizeError(new Error(found.log ?? "The enclave rejected the instruction.")));
        return;
      }
      setResult(found);
    } catch (e) {
      setProblem(humanizeError(e));
    } finally {
      setPolling(false);
    }
  };

  return (
    <section className="step">
      <PanelHead
        title="Collect and relay the result"
        why="The enclave signs its answer; the chain verifies that signature. Relaying is permissionless — anyone holding the signed result can submit it, so you cannot suppress an outcome you dislike by declining to send this transaction."
      />

      <dl className="facts">
        <div>
          <dt>Instruction</dt>
          <dd>
            <code>{round.computeInstructionId}</code>
          </dd>
        </div>
      </dl>

      {!result ? (
        <div className="panel-actions">
          <button className="btn btn-primary spacer" disabled={polling} onClick={poll}>
            {polling ? "Waiting for the enclave…" : "Check for the result"}
          </button>
        </div>
      ) : (
        <>
          <DoneNote>
            <strong>Signed result received.</strong> The contract will re-derive the same hash and
            recover the signer before accepting it.
          </DoneNote>
          <div className="panel-actions">
            <button
              className="btn btn-primary spacer"
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
                  setSuccess({
                    title: "Round finalized",
                    body: (
                      <p>
                        The chain now holds a Merkle root, a total and a count — and no individual
                        allocation. Recipients can claim.
                      </p>
                    ),
                  });
                })
              }
            >
              {busy === "finalize" ? "Finalizing…" : "Finalize round"}
            </button>
          </div>
        </>
      )}

      <ErrorDialog error={problem} onClose={() => setProblem(null)} />
    </section>
  );
}

function SettledPanel({ roundId, round }: { roundId: bigint; round: Round }) {
  return (
    <section className="step">
      <PanelHead
        title="Settled"
        why="The round is finalized. What is public is an aggregate; what is private stayed private."
      />

      <DoneNote>
        <strong>Round {String(roundId)} is complete.</strong> Recipients can request a disclosure
        and claim without you mediating.
      </DoneNote>

      <dl className="facts">
        <div>
          <dt>Allocated</dt>
          <dd>{formatTokenAmount(round.totalAllocated)} C2FLR</dd>
        </div>
        <div>
          <dt>Recipients</dt>
          <dd>{round.recipientCount}</dd>
        </div>
        <div>
          <dt>Claimed so far</dt>
          <dd>{formatTokenAmount(round.totalClaimed)} C2FLR</dd>
        </div>
        <div>
          <dt>Merkle root</dt>
          <dd>
            <code>{round.merkleRoot}</code>
          </dd>
        </div>
      </dl>

      <div className="panel-actions">
        <Link className="btn btn-secondary" href="/claim">
          Recipient portal
        </Link>
        <Link className="btn btn-primary spacer" href={`/verify/${roundId}`}>
          Verification report
          <IconArrowRight size={15} className="btn-arrow" />
        </Link>
      </div>

      <p className="hint">
        Tell recipients the round number; they need nothing else from you.
      </p>
    </section>
  );
}
