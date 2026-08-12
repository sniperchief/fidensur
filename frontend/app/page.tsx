/**
 * Landing page.
 *
 * Its job is to make one idea obvious before anyone reads a paragraph: **sensitive financial
 * operations can stay private without becoming unverifiable.** Everything below is arranged
 * around that single claim — the hero diagram states it, the comparison shows why the two halves
 * are usually a trade-off, and the verification section shows what makes it not one here.
 *
 * ## Two rules this page keeps
 *
 * 1. **No claim beyond what the system does.** The privacy limitation — that claiming is
 *    self-disclosure — is stated on the page rather than left for a reader to discover later, and
 *    the deployment's simulated attestation is in the footer on every route. A reader who finds a
 *    caveat after being sold will reasonably distrust everything else.
 *
 * 2. **The illustrations are labelled as illustrations.** The verification panel is a picture of
 *    a passing report, not a report. See components/marketing/VerificationPanel.tsx.
 *
 * Real numbers live at /dashboard and /verify, read from the chain.
 */

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { EnclaveDiagram } from "@/components/marketing/EnclaveDiagram";
import { HeroVisual } from "@/components/marketing/HeroVisual";
import { ProcessDiagram } from "@/components/marketing/ProcessDiagram";
import { VerificationPanel } from "@/components/marketing/VerificationPanel";
import { GridBackground } from "@/components/ui/GridBackground";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Badge } from "@/components/ui/StatusBadge";
import {
  IconAcademic,
  IconArrowRight,
  IconBadgeCheck,
  IconBank,
  IconChip,
  IconCoins,
  IconGift,
  IconLink,
  IconLock,
  IconSearch,
  IconShieldCheck,
  IconTarget,
  IconUsers,
} from "@/components/ui/Icons";

const TRUST = [
  { label: "Powered by Flare", Icon: IconLink },
  { label: "TEE confidential compute", Icon: IconChip },
  { label: "Attested execution", Icon: IconShieldCheck },
  { label: "On-chain settlement", Icon: IconCoins },
  { label: "Public verification", Icon: IconBadgeCheck },
];

/** The two axes the whole product turns on, asked identically of all three approaches. */
const APPROACHES = [
  {
    name: "Public by default",
    kicker: "Transparent chains",
    body: "Paying contributors on-chain publishes the whole distribution. Every amount, every address, permanently, to anyone who looks.",
    private: false,
    verifiable: true,
    solution: false,
  },
  {
    name: "Private but opaque",
    kicker: "Centralized systems",
    body: "A payroll provider keeps the numbers private, and asks you to take its word that it applied the rules you agreed. There is nothing to check.",
    private: true,
    verifiable: false,
    solution: false,
  },
  {
    name: "Fidensur",
    kicker: "Confidential compute",
    body: "The allocation is computed inside an attested enclave. The distribution stays private; the fact that the published program produced it does not.",
    private: true,
    verifiable: true,
    solution: true,
  },
];

const TEE_POINTS = [
  {
    Icon: IconLock,
    title: "The operator cannot read the inputs",
    body: "The policy is encrypted in the browser to a key that only exists inside the enclave. There is no server that ever holds the plaintext — not briefly, not in a log.",
  },
  {
    Icon: IconChip,
    title: "The code is published and reproducible",
    body: "The enclave image builds bit-for-bit identically on independent machines, so the hash it attests to is one you can reproduce from source yourself.",
  },
  {
    Icon: IconBadgeCheck,
    title: "Only an aggregate leaves",
    body: "A Merkle root, a total and a recipient count. Individual addresses and amounts are not on-chain and are not derivable from the root.",
  },
];

const USE_CASES = [
  {
    Icon: IconCoins,
    title: "Contributor rewards",
    body: "Calculate contributor allocations from private weights without publishing who was valued at what.",
  },
  {
    Icon: IconUsers,
    title: "Payroll",
    body: "Run salaries on-chain while individual compensation stays between the organization and the employee.",
  },
  {
    Icon: IconGift,
    title: "Grants",
    body: "Distribute funding without exposing which applications scored well and which did not.",
  },
  {
    Icon: IconTarget,
    title: "Bounties",
    body: "Settle contributor rewards against a private rubric, with a public record that the rubric ran.",
  },
  {
    Icon: IconAcademic,
    title: "Scholarships",
    body: "Protect recipient allocation information, which is often the most sensitive thing an award reveals.",
  },
  {
    Icon: IconBank,
    title: "DAO treasury",
    body: "Execute governance-driven distributions where the mandate is public and the breakdown is not.",
  },
];

const CHAIN = [
  {
    label: "Stage 01",
    title: "Private inputs",
    body: "Encrypted client-side to the enclave's attested key. The ciphertext is all that is ever transmitted or stored.",
  },
  {
    label: "Stage 02",
    title: "TEE execution",
    body: "Decryption and allocation happen inside hardware-isolated memory the host operator cannot inspect.",
  },
  {
    label: "Stage 03",
    title: "Code attestation",
    body: "The enclave signs its result with a key bound to a measurement of the exact image it is running.",
  },
  {
    label: "Stage 04",
    title: "On-chain settlement",
    body: "The contract recovers the signer before accepting anything, and recipients claim against the committed root.",
  },
];

export default function LandingPage() {
  const router = useRouter();
  const [round, setRound] = useState("");

  const trimmed = round.trim();
  const valid = /^\d+$/.test(trimmed);

  return (
    <main>
      {/* ================= hero ================= */}
      <section className="section hero">
        <GridBackground fade="center" strong />
        <div className="shell hero-inner">
          <Reveal className="hero-copy">
            <p className="eyebrow">Confidential treasury allocation</p>
            <h1>
              Private treasury operations.{" "}
              <span className="accent-text">Publicly verifiable execution.</span>
            </h1>
            <p className="lede">
              Fidensur uses Flare Confidential Compute to process sensitive treasury allocations
              inside a Trusted Execution Environment while keeping the computation verifiable.
            </p>

            <div className="hero-actions">
              <Link className="btn btn-primary btn-lg" href="/dashboard">
                Launch app
                <IconArrowRight size={16} className="btn-arrow" />
              </Link>
              <Link className="btn btn-secondary btn-lg" href="/verify">
                Explore verification
              </Link>
            </div>

            <p className="hero-meta">
              <Badge kind="neutral">Coston2 testnet</Badge>
              No backend. Every transaction is built and signed in your browser.
            </p>
          </Reveal>

          <Reveal delay={90}>
            <HeroVisual />
          </Reveal>
        </div>
      </section>

      {/* ================= trust strip ================= */}
      <section className="trust-strip">
        <div className="shell">
          <ul className="trust-list">
            {TRUST.map(({ label, Icon }) => (
              <li key={label}>
                <Icon size={15} />
                {label}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ================= problem ================= */}
      <section className="section">
        <div className="shell">
          <Reveal>
            <SectionHeading
              eyebrow="The trade-off"
              title="Financial operations shouldn't require choosing between privacy and proof."
              lede="Every existing option asks you to give up one of them. A transparent chain publishes the distribution to get auditability; a centralized processor keeps it quiet and asks to be trusted. Neither is a good answer for money that belongs to other people."
            />
          </Reveal>

          <Reveal className="compare-grid">
            {APPROACHES.map((approach) => (
              <article
                className="compare-card"
                key={approach.name}
                data-solution={approach.solution}
              >
                <div className="compare-head">
                  <h3>{approach.name}</h3>
                  {approach.solution && (
                    <Badge kind="progress" dot={false}>
                      This product
                    </Badge>
                  )}
                </div>
                <p>{approach.body}</p>

                <ul className="compare-traits">
                  <li>
                    <span className="trait-label">Allocations stay private</span>
                    <TraitValue ok={approach.private} />
                  </li>
                  <li>
                    <span className="trait-label">Execution is verifiable</span>
                    <TraitValue ok={approach.verifiable} />
                  </li>
                </ul>
              </article>
            ))}
          </Reveal>
        </div>
      </section>

      {/* ================= how it works ================= */}
      <section className="section section-subtle" id="how-it-works">
        <GridBackground fade="bottom" strong />
        <div className="shell">
          <Reveal>
            <SectionHeading
              eyebrow="How Fidensur works"
              title="Five steps, and only one of them is invisible."
              lede="Everything except the allocation itself happens in the open — on your machine, or on chain, where you can watch it."
            />
          </Reveal>
          <Reveal>
            <ProcessDiagram />
          </Reveal>
        </div>
      </section>

      {/* ================= confidential computation ================= */}
      <section className="section">
        <div className="shell tee-layout">
          <Reveal>
            <SectionHeading
              eyebrow="Confidential computation"
              title="The sensitive logic stays private. The result stays verifiable."
            />
            <ul className="tee-points">
              {TEE_POINTS.map(({ Icon, title, body }) => (
                <li key={title}>
                  <span className="point-mark" aria-hidden="true">
                    <Icon size={14} />
                  </span>
                  <div>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={80}>
            <EnclaveDiagram />
          </Reveal>
        </div>
      </section>

      {/* ================= verification ================= */}
      <section className="section section-subtle" id="verification">
        <GridBackground fade="edges" strong />
        <div className="shell tee-layout">
          <Reveal>
            <SectionHeading
              eyebrow="Verification"
              title="Don't trust the computation. Verify it."
              lede="A confidential backend that asks for trust has not solved the problem, it has moved it. Every Fidensur round publishes enough for a stranger to check the work: which program ran, that it ran in a real enclave, and that the signature on the result came from that enclave."
            />
            <p className="note">
              The report re-derives every check in your browser — signature recovery included —
              independently of the contract. Two implementations agreeing is evidence; one checking
              itself is not.
            </p>
          </Reveal>

          <Reveal delay={80}>
            <VerificationPanel />
          </Reveal>
        </div>
      </section>

      {/* ================= explorer CTA ================= */}
      <section className="section section-tight">
        <div className="shell">
          <Reveal className="explorer-cta">
            <div>
              <SectionHeading
                eyebrow="Verification explorer"
                title="Verify any Fidensur execution."
                lede="Open a round and inspect the confidential execution behind it — code identity, attestation, signature recovery, and the arithmetic the contract enforced."
              />
            </div>

            <div>
              <form
                className="search-field"
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
                  value={round}
                  onChange={(e) => setRound(e.target.value)}
                  placeholder="Round number, e.g. 0"
                  inputMode="numeric"
                  autoComplete="off"
                />
                <button className="btn btn-primary" type="submit" disabled={!valid}>
                  <IconSearch size={15} />
                  Verify
                </button>
              </form>
              <p className="hint">
                Rounds are numbered from 0 in the order they were created.{" "}
                <Link href="/verify">Browse every round →</Link>
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================= use cases ================= */}
      <section className="section section-subtle" id="use-cases">
        <div className="shell">
          <Reveal>
            <SectionHeading
              eyebrow="Use cases"
              title="Built for sensitive treasury operations."
              lede="Anywhere the total should be public and the breakdown should not."
              center
            />
          </Reveal>

          <Reveal className="usecase-grid">
            {USE_CASES.map(({ Icon, title, body }) => (
              <article className="usecase" key={title}>
                <h3>
                  <Icon size={17} />
                  {title}
                </h3>
                <p>{body}</p>
              </article>
            ))}
          </Reveal>
        </div>
      </section>

      {/* ================= trust model ================= */}
      <section className="section section-deep">
        <div className="shell">
          <Reveal>
            <SectionHeading
              eyebrow="Trust model"
              title="Four stages, and what each one actually guarantees."
              lede="Each stage constrains the one before it. Taken together they are what lets a round be private and checkable at the same time."
            />
          </Reveal>

          <Reveal className="chain">
            {CHAIN.map((stage) => (
              <article className="chain-stage" key={stage.label}>
                <span className="stage-label">{stage.label}</span>
                <h3>{stage.title}</h3>
                <p>{stage.body}</p>
              </article>
            ))}
          </Reveal>

          {/* The one limitation, given its own space rather than a footnote. A reader who finds
              this later, elsewhere, would be right to discount everything above it. */}
          <Reveal>
            <div
              className="callout warn"
              style={{ marginTop: "var(--s10)", maxWidth: "52rem" }}
            >
              <strong>Claiming is self-disclosure.</strong> A settled transfer of <em>N</em> tokens
              to address <em>A</em> is publicly visible, like any transfer. Fidensur keeps every
              unclaimed allocation private and never reveals the distribution as a whole, but it
              cannot make a completed payment invisible on a transparent chain. This is not
              anonymity, and anyone claiming otherwise for this kind of system is overselling it.
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================= final CTA ================= */}
      <section className="section final-cta">
        <GridBackground fade="center" strong />
        <div className="shell">
          <Reveal>
            <h2>Build treasury workflows that don&rsquo;t compromise privacy.</h2>
            <p>
              Fidensur brings confidential computation and public verification together on Flare.
            </p>
            <div className="btn-group">
              <Link className="btn btn-primary btn-lg" href="/dashboard">
                Launch Fidensur
                <IconArrowRight size={16} className="btn-arrow" />
              </Link>
              <Link className="btn btn-secondary btn-lg" href="/verify">
                View verification explorer
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </main>
  );
}

/** Yes/no on one of the two axes. The word carries it; the mark is reinforcement. */
function TraitValue({ ok }: { ok: boolean }) {
  return (
    <>
      <span className="trait-value" data-ok={ok}>
        {ok ? "Yes" : "No"}
      </span>
      <span className="trait-mark" data-ok={ok} aria-hidden="true">
        {ok ? <IconCheckMark /> : <IconCrossMark />}
      </span>
    </>
  );
}

function IconCheckMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function IconCrossMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6 18 18M18 6 6 18" />
    </svg>
  );
}
