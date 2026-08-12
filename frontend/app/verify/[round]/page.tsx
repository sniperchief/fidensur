/**
 * Public verification report for one allocation round.
 *
 * This page is the product's centre of gravity, not a debug view. It answers, in order, the six
 * questions a skeptical stranger would ask — and for each one it shows the raw values and the
 * derivation, rather than a green tick.
 *
 * The design rule throughout: **never ask the reader to trust this page.** Every check is
 * re-derived client-side from chain state and the proxy's attestation report, using code that is
 * deliberately independent of the contract. Where a value cannot be independently confirmed, the
 * page says so instead of implying otherwise.
 *
 * ## Why there is a verdict at the top now
 *
 * The report used to open with its first question and close, three thousand pixels later, with
 * its last. Everything needed was on the page and none of it was findable. A reader had no way to
 * learn the outcome without reading the argument, which sounds rigorous and is really just poor
 * structure.
 *
 * So the outcome is stated first, and is *derived* — see lib/verdict.ts. It cannot say "verified"
 * unless every check ran and passed, it counts an unreachable check as unreachable rather than
 * quietly dropping it, and the tally beside it can be audited against the sections below. The rail
 * lists all six questions with their individual outcomes, so a section that could not be checked
 * is still visible rather than omitted.
 *
 * Nothing about the evidence changed. Hashes are still shown in full where the exact value
 * matters, verdicts are still words as well as colour, and the caveats are still louder than the
 * conclusions.
 */

"use client";

import { use, useEffect, useMemo, useState } from "react";
import { createPublicClient, http, type Address, type Hex } from "viem";

import { CheckRail } from "@/components/verify/CheckRail";
import { VerdictHeader } from "@/components/verify/VerdictHeader";
import { CodeHash } from "@/components/ui/Mono";
import {
  COSTON2,
  FIDENSUR_READ_ABI,
  NATIVE_TOKEN,
  statusName,
  type Round,
} from "@/lib/contracts";
import { formatTokenAmount } from "@/lib/format";
import { ProxyClient } from "@/lib/proxy";
import { deriveVerdict } from "@/lib/verdict";
import {
  abbreviate,
  assessAttestation,
  decodeVersion,
  verifyActionResult,
  type ActionResult,
  type AttestationReport,
  type AttestationVerdict,
  type VerificationSteps,
} from "@/lib/verify";

const CONTRACT = process.env.NEXT_PUBLIC_FIDENSUR_CONTRACT as Address | undefined;
const PROXY_URL = process.env.NEXT_PUBLIC_EXT_PROXY_URL;

const client = createPublicClient({ chain: COSTON2, transport: http() });

interface PageState {
  round?: Round;
  teeAddress?: Address;
  extensionId?: bigint;
  attestation?: AttestationReport | null;
  verdict?: AttestationVerdict;
  result?: ActionResult | null;
  steps?: VerificationSteps;
  error?: string;
  /** The round has never been created. Distinct from an error — it is the expected answer here. */
  notFound?: boolean;
  loading: boolean;
}

// `params` is a Promise, even in a client component — Next 15 changed this. Unwrapping it with
// `use()` is required; typing it as a plain object type-checks and then fails at runtime.
export default function VerifyRoundPage({ params }: { params: Promise<{ round: string }> }) {
  // Named roundParam, not round: the round *object* is destructured from state further down, in
  // this same scope, and two `const round` declarations would be a duplicate-binding SyntaxError.
  const { round: roundParam } = use(params);

  // A non-numeric segment arrives here as a string and BigInt() throws on it. Guard so a mistyped
  // URL renders a message instead of an unhandled exception.
  const roundId = useMemo(() => {
    try {
      return BigInt(roundParam);
    } catch {
      return null;
    }
  }, [roundParam]);

  const [state, setState] = useState<PageState>({ loading: true });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!CONTRACT) throw new Error("NEXT_PUBLIC_FIDENSUR_CONTRACT is not set");
        if (roundId === null) throw new Error(`"${roundParam}" is not a valid round number`);

        const [roundData, teeAddress, extensionId] = await Promise.all([
          client.readContract({
            address: CONTRACT,
            abi: FIDENSUR_READ_ABI,
            functionName: "getRound",
            args: [roundId],
          }) as Promise<Round>,
          client.readContract({
            address: CONTRACT,
            abi: FIDENSUR_READ_ABI,
            functionName: "teeAddress",
          }) as Promise<Address>,
          client.readContract({
            address: CONTRACT,
            abi: FIDENSUR_READ_ABI,
            functionName: "extensionId",
          }) as Promise<bigint>,
        ]);

        // The attestation report is best-effort: the proxy may be down, or behind a tunnel that has
        // since closed. A missing report is reported as missing, never silently treated as a pass.
        let attestation: AttestationReport | null = null;
        let verdict: AttestationVerdict | undefined;
        if (PROXY_URL) {
          try {
            attestation = await new ProxyClient(PROXY_URL).attestation();
            if (attestation) verdict = assessAttestation(attestation, extensionId.toString());
          } catch {
            attestation = null;
          }
        }

        // The signed result is what the signature check runs against. It is only obtainable while
        // the proxy still holds it; an older round may legitimately have none available.
        let result: ActionResult | null = null;
        let steps: VerificationSteps | undefined;
        if (PROXY_URL && roundData.computeInstructionId) {
          try {
            result = await new ProxyClient(PROXY_URL).result(roundData.computeInstructionId);
            if (result && result.status === 1) {
              steps = await verifyActionResult(result, teeAddress, COSTON2.id);
            }
          } catch {
            result = null;
          }
        }

        if (!cancelled) {
          setState({ round: roundData, teeAddress, extensionId, attestation, verdict, result, steps, loading: false });
        }
      } catch (e) {
        if (!cancelled) {
          const raw = e instanceof Error ? e.message : String(e);

          // A round that has never been created is the single most likely reason someone lands
          // here — a guessed URL, or a stale link. The contract reverts with NoSuchRound, which is
          // correct behaviour and not an error worth showing as a stack trace.
          const notFound = raw.includes("NoSuchRound") || raw.includes("0x6a4fd69d");

          setState({ loading: false, notFound, error: notFound ? undefined : raw });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [roundId]);

  if (state.loading) {
    return (
      <Shell>
        <p className="hint">Reading round {roundParam} from the chain…</p>
      </Shell>
    );
  }

  if (state.notFound) {
    return (
      <Shell>
        <h1>Round {roundParam}</h1>
        <Callout kind="unknown">
          <p style={{ margin: "0 0 0.5rem" }}>
            <strong>This round does not exist.</strong>
          </p>
          <p style={{ margin: 0 }}>
            The contract is live and responded — it simply has no round numbered {roundParam} yet.
            Rounds are numbered from 0 in the order they are created.
          </p>
        </Callout>
        <p>
          <a href="/verify">← Browse every round</a>
        </p>
      </Shell>
    );
  }

  if (state.error) {
    return (
      <Shell>
        <Callout kind="fail">{state.error}</Callout>
      </Shell>
    );
  }

  const { round, teeAddress, attestation, verdict, result, steps } = state;
  if (!round) {
    return (
      <Shell>
        <Callout kind="fail">Round not found.</Callout>
      </Shell>
    );
  }

  const finalized = statusName(round.status) === "Finalized" || statusName(round.status) === "Closed";
  const symbol = round.token === NATIVE_TOKEN ? "C2FLR" : "tokens";

  const report = deriveVerdict({
    round,
    attestationAvailable: Boolean(PROXY_URL && attestation),
    attestation: verdict,
    steps,
    resultAvailable: Boolean(result),
  });

  return (
    <Shell>
      <VerdictHeader roundId={roundParam} status={round.status} verdict={report} />

      <dl className="summary">
        <div>
          <dt>Organization</dt>
          <dd>
            <CodeHash value={round.organization} lead={8} tail={6} label="organization address" />
          </dd>
        </div>
        <div>
          <dt>Recipients</dt>
          <dd>{round.recipientCount || "—"}</dd>
        </div>
        <div>
          <dt>Allocated</dt>
          <dd>
            {formatTokenAmount(round.totalAllocated)} {symbol}
          </dd>
        </div>
        <div>
          <dt>Claimed</dt>
          <dd>
            {formatTokenAmount(round.totalClaimed)} {symbol}
          </dd>
        </div>
      </dl>

      <div className="report-layout">
        <CheckRail sections={report.sections} />

        <div className="report-body">
          {/* 1 — is the enclave real? */}
          <Section
            n={1}
            title="Did the computation run inside a real TEE?"
            why="A signature only means something if the key lives somewhere the operator cannot reach. This is the proxy's own attestation report."
          >
            {!PROXY_URL && (
              <Callout kind="unknown">
                No proxy URL is configured, so attestation cannot be checked from this page.
              </Callout>
            )}
            {PROXY_URL && !attestation && (
              <Callout kind="unknown">
                The proxy did not return an attestation report. It may be offline. This is not a
                failed check — it is an absent one.
              </Callout>
            )}
            {attestation && verdict && (
              <>
                <Check ok={verdict.isRealPlatform} label="Platform is GCP_AMD_SEV">
                  <code>{abbreviate(attestation.platform, 26, 6)}</code>
                </Check>
                <Check ok={!verdict.isSimulatedCodeHash} label="Code hash is a real measurement">
                  <CodeHash value={attestation.codeHash} wrap label="code hash" />
                  {verdict.isSimulatedCodeHash && (
                    <em> — this is the simulated hash. Results from this machine are not FTDC-accepted.</em>
                  )}
                </Check>
                <Check
                  ok={verdict.matchesRegisteredExtension}
                  label="Extension ID matches on-chain registration"
                >
                  <code>{attestation.extensionId}</code>
                </Check>
                {!verdict.trustworthy && (
                  <Callout kind="warn">
                    This deployment is running with simulated or unverified attestation. Everything
                    below still demonstrates the mechanism, but it does not establish that a genuine
                    enclave produced the result.
                  </Callout>
                )}
              </>
            )}
          </Section>

          {/* 2 — is the running code the published code? */}
          <Section
            n={2}
            title="Is the running code the published code?"
            why="Attestation proves some program ran in an enclave. Reproducibility is what ties that program to source you can read."
          >
            {attestation ? (
              <>
                <Field label="Attested code hash">
                  <CodeHash value={attestation.codeHash} wrap label="code hash" />
                </Field>
                <p>
                  The Go image is bit-for-bit reproducible across machines. Rebuild the published
                  commit and confirm the hash matches:
                </p>
                <pre>{`git checkout <commit>
docker build --build-arg SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \\
  -t fidensur-extension ./extension`}</pre>
                <Callout kind="unknown">
                  This page cannot perform that rebuild for you. It is the one check that requires
                  running something yourself — which is the point.
                </Callout>
              </>
            ) : (
              <Callout kind="unknown">No attestation report available.</Callout>
            )}
          </Section>

          {/* 3 — is the signature valid? */}
          <Section
            n={3}
            title="Is the TEE signature valid?"
            why="Recovered in your browser, independently of the contract. Every intermediate value is shown so you can reproduce the derivation by hand."
          >
            {!result && (
              <Callout kind="unknown">
                No signed result is available from the proxy for this round&rsquo;s instruction.
              </Callout>
            )}
            {result && result.status !== 1 && (
              <Callout kind="fail">
                The TEE reported status {result.status}. Only status 1 is relayable.
              </Callout>
            )}
            {steps && (
              <>
                <Field label="keccak256(resultData)">
                  <CodeHash value={steps.dataHash} wrap label="data hash" />
                </Field>
                <Field label="ActionResult.Hash()">
                  <CodeHash value={steps.resultHash} wrap label="result hash" />
                </Field>
                <Field label="Domain-separated payload">
                  <CodeHash value={steps.payloadHash} wrap label="payload hash" />
                </Field>
                <Field label="EIP-191 digest">
                  <CodeHash value={steps.eip191Digest} wrap label="digest" />
                </Field>
                <Check ok={steps.signerOk} label="Recovered signer is the registered TEE">
                  <code>{steps.recoveredSigner ?? "recovery failed"}</code>
                  {!steps.signerOk && (
                    <em>
                      {" "}
                      — expected <code>{steps.expectedSigner}</code>
                    </em>
                  )}
                </Check>
                <p className="note">
                  The payload hash wraps the result hash in{" "}
                  <code>abi.encode(bytes32(&quot;TEE_ACTION_RESULT&quot;), chainId, resultHash)</code>.
                  Binding <code>chainId</code> ({steps.chainId}) is what prevents this signature
                  being replayed on another chain.
                </p>
              </>
            )}
          </Section>

          {/* 4 — does the arithmetic hold? */}
          <Section
            n={4}
            title="Does the arithmetic hold?"
            why="Enforced by the contract, and re-checked here against the same public values."
          >
            <Check ok={round.totalAllocated <= round.funded} label="Allocated does not exceed funded">
              {formatTokenAmount(round.totalAllocated)} ≤ {formatTokenAmount(round.funded)} {symbol}
            </Check>
            <Check
              ok={round.totalClaimed <= round.totalAllocated}
              label="Claimed does not exceed allocated"
            >
              {formatTokenAmount(round.totalClaimed)} ≤ {formatTokenAmount(round.totalAllocated)}{" "}
              {symbol}
            </Check>
            <Field label="Unclaimed">
              {formatTokenAmount(round.totalAllocated - round.totalClaimed)} {symbol}
              {finalized && <em> — returns to the organization after the claim window closes.</em>}
            </Field>
          </Section>

          {/* 5 — was the committed policy the one evaluated? */}
          <Section
            n={5}
            title="Was the committed policy the one evaluated?"
            why="The commitment is recorded on-chain before the ciphertext is dispatched, so the policy cannot be swapped afterwards."
          >
            <Field label="Policy commitment">
              <CodeHash value={round.policyCommitment} wrap label="policy commitment" />
            </Field>
            <Field label="Compute instruction">
              <CodeHash value={round.computeInstructionId} wrap label="instruction id" />
            </Field>
            <p className="note">
              <code>requestCompute</code> rejects any ciphertext that does not hash to the
              commitment, and <code>finalizeRound</code> rejects any result reporting a different
              one. An organization can publish its ciphertext later; recomputing{" "}
              <code>keccak256</code> over it and comparing to the value above proves which bytes the
              enclave evaluated — without revealing the policy.
            </p>
          </Section>

          {/* 6 — what is committed, and what stays private */}
          <Section
            n={6}
            title="What the root commits to"
            why="The Merkle root fixes every allocation without publishing any of them."
          >
            <Field label="Merkle root">
              <CodeHash value={round.merkleRoot} wrap label="merkle root" />
            </Field>
            <Field label="Recipients">{round.recipientCount}</Field>
            <Field label="Engine version">
              <code>{decodeVersion(round.engineVersion)}</code>
            </Field>
            <p className="note">
              Individual addresses and amounts are not on-chain and are not derivable from the root.
              A recipient proves their own entry with a Merkle proof; nobody learns anyone
              else&apos;s.
            </p>
            <Callout kind="warn">
              Claiming is self-disclosure. A settled transfer of <em>N</em> to address <em>A</em> is
              publicly visible, like any other transfer. Fidensur keeps unclaimed allocations
              private and never reveals the distribution as a whole, but it cannot make a settled
              payment invisible.
            </Callout>
          </Section>

          <footer>
            <p>
              Verified against contract <code>{CONTRACT}</code> on {COSTON2.name}. Registered TEE:{" "}
              <code>{teeAddress}</code>.
            </p>
          </footer>
        </div>
      </div>
    </Shell>
  );
}

/* ---------- presentation ---------- */

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="report">{children}</main>;
}

function Section({
  n,
  title,
  why,
  children,
}: {
  n: number;
  title: string;
  why: string;
  children: React.ReactNode;
}) {
  return (
    <section id={`check-${n}`}>
      <h2>
        <span className="num">{n}</span> {title}
      </h2>
      <p className="why">{why}</p>
      {children}
    </section>
  );
}

/**
 * A pass/fail line.
 *
 * The raw value is always rendered beside the verdict. A verification UI that shows only a tick is
 * asking to be trusted, which is exactly what this page is trying to avoid.
 */
function Check({ ok, label, children }: { ok: boolean; label: string; children?: React.ReactNode }) {
  return (
    <div className={ok ? "check pass" : "check fail"}>
      <span className="mark">{ok ? "PASS" : "FAIL"}</span>
      <span className="label">{label}</span>
      {children && <div className="value">{children}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="value">{children}</div>
    </div>
  );
}

function Callout({
  kind,
  children,
}: {
  kind: "pass" | "fail" | "warn" | "unknown";
  children: React.ReactNode;
}) {
  return <div className={`callout ${kind}`}>{children}</div>;
}
