/**
 * Why this needs Flare specifically.
 *
 * "Powered by Flare" in a logo strip answers where the contract was deployed, not why the design
 * requires it — and a reader who cannot tell the difference will assume there isn't one.
 *
 * The argument is a single comparison, so it is drawn as one. Confidential computation on a chain
 * with no on-chain attestation registry means somebody has to check the enclave's report and tell
 * the contract the answer. That somebody is a trusted party, which is precisely what the product
 * exists to remove — you have swapped trusting the operator for trusting the verifier.
 *
 * Flare puts the registry of attested machines in contract state. `teeAddress()` is storage, not
 * an API response, so verification is a read rather than a request. Nobody is asked to vouch.
 *
 * The addresses below are the live deployment's, so the claim is checkable from the page making
 * it rather than being an illustration.
 */

import { Badge } from "@/components/ui/StatusBadge";
import { IconChip, IconLock, IconShieldCheck } from "@/components/ui/Icons";

const CONTRACT = process.env.NEXT_PUBLIC_FIDENSUR_CONTRACT ?? "";

const LANES = [
  {
    kind: "without",
    label: "A TEE on a chain that can't check it",
    verdict: "Trusted party remains",
    tone: "fail" as const,
    steps: [
      { text: "The enclave signs its result", flagged: false },
      { text: "An off-chain service inspects the attestation report", flagged: true },
      { text: "The contract accepts that service's word for it", flagged: true },
    ],
    note: "The operator is gone and a verifier has taken their place. Someone is still being believed.",
  },
  {
    kind: "with",
    label: "Flare Confidential Compute",
    verdict: "Nothing left to trust",
    tone: "pass" as const,
    steps: [
      { text: "The enclave signs its result", flagged: false },
      { text: "The registry of attested machines is already contract state", flagged: false },
      { text: "The contract recovers the signer and compares it itself", flagged: false },
    ],
    note: "Verification is a storage read. The chain holding the money is the chain that checks who computed the split.",
  },
];

export function WhyFlare() {
  return (
    <>
      <div className="trust-compare">
        {LANES.map((lane) => (
          <article className="trust-lane" data-kind={lane.kind} key={lane.kind}>
            <header className="lane-head">
              <span className="lane-label">{lane.label}</span>
              <Badge kind={lane.tone} dot={false}>
                {lane.verdict}
              </Badge>
            </header>

            <ol className="lane-steps">
              {lane.steps.map((step) => (
                <li key={step.text} data-flagged={step.flagged}>
                  <span className="lane-mark" aria-hidden="true">
                    {step.flagged ? <IconLock size={11} /> : <IconShieldCheck size={11} />}
                  </span>
                  {step.text}
                </li>
              ))}
            </ol>

            <p className="lane-note">{lane.note}</p>
          </article>
        ))}
      </div>

      {/* Grounding the argument in the deployment's own state, so it can be checked rather than
          taken on the same faith the section is arguing against. */}
      <div className="chain-state">
        <span className="chain-state-label">What the contract reads, on-chain</span>
        <dl>
          <div>
            <dt>
              <IconShieldCheck size={13} />
              <code>teeAddress()</code>
            </dt>
            <dd>The enclave whose signature this round will accept</dd>
          </div>
          <div>
            <dt>
              <IconChip size={13} />
              <code>extensionId()</code>
            </dt>
            <dd>The published program the enclave is registered to run</dd>
          </div>
        </dl>
        {CONTRACT && (
          <p className="hint">
            Both are public storage on{" "}
            <code>
              {CONTRACT.slice(0, 10)}…{CONTRACT.slice(-6)}
            </code>{" "}
            — no Fidensur service is involved in answering them.
          </p>
        )}
      </div>
    </>
  );
}
