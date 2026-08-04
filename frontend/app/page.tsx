/**
 * Landing page.
 *
 * Its job is to explain the claim accurately and get a reader to a verification report. It states
 * the privacy limitation up front rather than burying it, because a reader who discovers that
 * limitation later will reasonably distrust everything else on the page.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const CONTRACT = process.env.NEXT_PUBLIC_FIDENSUR_CONTRACT ?? "";
const EXPLORER = "https://coston2-explorer.flare.network";

export default function LandingPage() {
  const router = useRouter();
  const [round, setRound] = useState("");

  const trimmed = round.trim();
  const valid = /^\d+$/.test(trimmed);

  return (
    <main className="landing">
      <h1>Fidensur</h1>
      <p className="tagline">Allocate funds privately. Prove the computation publicly.</p>

      <p>
        An organization commits to an encrypted allocation policy on-chain. A Trusted Execution
        Environment decrypts it, computes who gets what, and signs an aggregate — a Merkle root, a
        total, a recipient count. Individual addresses, amounts, and allocation rules never reach
        the chain.
      </p>

      <p>
        Anyone can verify that a specific published program ran inside a real enclave and produced
        that aggregate, without learning anything it was meant to hide.
      </p>

      <h2>Verify a round</h2>
      <form
        className="lookup"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) router.push(`/verify/${trimmed}`);
        }}
      >
        <input
          value={round}
          onChange={(e) => setRound(e.target.value)}
          placeholder="Round number, e.g. 0"
          inputMode="numeric"
          aria-label="Round number"
        />
        <button type="submit" disabled={!valid}>
          Verify
        </button>
      </form>
      <p className="note">
        The report re-derives every check in your browser — signature recovery included —
        independently of the contract. Two implementations agreeing is evidence; one checking itself
        is not.
      </p>

      <h2>What stays private</h2>
      <dl className="facts">
        <div>
          <dt>Recipient addresses</dt>
          <dd>never on-chain</dd>
        </div>
        <div>
          <dt>Individual amounts</dt>
          <dd>never on-chain</dd>
        </div>
        <div>
          <dt>Allocation rules, weights, salary bands</dt>
          <dd>never on-chain</dd>
        </div>
        <div>
          <dt>Merkle root, total, recipient count</dt>
          <dd>public</dd>
        </div>
        <div>
          <dt>An amount, once its recipient claims it</dt>
          <dd>public</dd>
        </div>
      </dl>

      <div className="callout warn">
        <strong>Claiming is self-disclosure.</strong> A settled transfer of <em>N</em> tokens to
        address <em>A</em> is publicly visible, like any transfer. Fidensur keeps every{" "}
        <em>unclaimed</em> allocation private and never reveals the distribution as a whole, but it
        cannot make a completed payment invisible on a transparent chain. This is not anonymity, and
        anyone claiming otherwise for this kind of system is overselling it.
      </div>

      <h2>Deployment</h2>
      <dl className="facts">
        <div>
          <dt>Network</dt>
          <dd>Coston2 (chain 114)</dd>
        </div>
        <div>
          <dt>Contract</dt>
          <dd>
            {CONTRACT ? (
              <a href={`${EXPLORER}/address/${CONTRACT}`} target="_blank" rel="noreferrer">
                <code>{CONTRACT}</code>
              </a>
            ) : (
              <em>NEXT_PUBLIC_FIDENSUR_CONTRACT not set</em>
            )}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            <a href="https://github.com/sniperchief/fidensur" target="_blank" rel="noreferrer">
              github.com/sniperchief/fidensur
            </a>
          </dd>
        </div>
      </dl>

      <div className="callout unknown">
        Testnet deployment running with <strong>simulated attestation</strong>. The mechanism is
        real and every signature is genuinely verified, but the enclave is not a production
        Confidential Space VM — so a report from this deployment demonstrates the design rather than
        attesting real funds. Verification reports say so explicitly.
      </div>
    </main>
  );
}
