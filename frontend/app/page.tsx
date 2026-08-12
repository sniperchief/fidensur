/**
 * Landing page.
 *
 * One job: a visitor should understand what this is within about ten seconds, in words they
 * already know. "Confidential treasury allocation with publicly verifiable execution" is accurate
 * and tells a newcomer nothing. "Pay people on-chain without publishing who got what" tells them
 * everything.
 *
 * ## What was removed, and why
 *
 * This page had twelve sections. A logo strip, a three-card problem comparison, a separate TEE
 * explainer, six use-case cards, and a four-stage trust diagram all went. Not because any of them
 * was wrong, but because each restated something another section already said — and a page that
 * says one thing five ways reads as a page with nothing to say.
 *
 * What survived is the argument in order: what it does, how it works, why it needs Flare, how you
 * check it, and where the evidence is. Removing a section is only cheap if nothing was load-
 * bearing, so the two honest caveats — claiming is self-disclosure, and attestation here is
 * simulated — were moved rather than dropped. They are the last thing on the page before the call
 * to action, which is where a reader who is deciding will actually read them.
 *
 * The verification panel remains labelled as an illustration. See VerificationPanel.tsx.
 */

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { HeroVisual } from "@/components/marketing/HeroVisual";
import { ProcessDiagram } from "@/components/marketing/ProcessDiagram";
import { VerificationPanel } from "@/components/marketing/VerificationPanel";
import { WhyFlare } from "@/components/marketing/WhyFlare";
import { GridBackground } from "@/components/ui/GridBackground";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHeading } from "@/components/ui/SectionHeading";
import {
  IconAcademic,
  IconArrowRight,
  IconBadgeCheck,
  IconBank,
  IconChip,
  IconCoins,
  IconDocument,
  IconExternal,
  IconGift,
  IconSearch,
  IconTarget,
  IconUsers,
} from "@/components/ui/Icons";
import { COSTON2 } from "@/lib/contracts";

const CONTRACT = process.env.NEXT_PUBLIC_FIDENSUR_CONTRACT ?? "";
const EXPLORER = COSTON2.blockExplorers.default.url;
const REPO = "https://github.com/sniperchief/fidensur";

/** Plain nouns, not product categories — someone should recognise their own situation here. */
const USE_CASES = [
  {
    Icon: IconCoins,
    title: "Contributor rewards",
    body: "Work out what each contributor earned without publishing who was valued at what.",
  },
  {
    Icon: IconUsers,
    title: "Payroll",
    body: "Run salaries on-chain while individual pay stays between you and the employee.",
  },
  {
    Icon: IconGift,
    title: "Grants",
    body: "Fund applicants without exposing which applications scored well and which did not.",
  },
  {
    Icon: IconTarget,
    title: "Bounties",
    body: "Settle rewards against a private rubric, with a public record that the rubric ran.",
  },
  {
    Icon: IconAcademic,
    title: "Scholarships",
    body: "Protect award amounts, which are often the most sensitive thing a scholarship reveals.",
  },
  {
    Icon: IconBank,
    title: "DAO treasury",
    body: "Execute a governance-approved distribution where the mandate is public and the split is not.",
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
            <p className="eyebrow">For DAOs, protocols and finance teams</p>
            <h1>
              Pay people on-chain without publishing{" "}
              <span className="accent-text">who got what.</span>
            </h1>
            <p className="lede">
              Fidensur works out each person&rsquo;s share inside sealed hardware, then puts only
              the total on-chain. Anyone can check the maths was done correctly. Nobody can see the
              amounts.
            </p>

            <div className="hero-actions">
              <Link className="btn btn-primary btn-lg" href="/dashboard">
                Open the app
                <IconArrowRight size={16} className="btn-arrow" />
              </Link>
              <Link className="btn btn-secondary btn-lg" href="/verify/1">
                See a verified round
              </Link>
            </div>

            <p className="hero-meta">Live on Flare&rsquo;s Coston2 testnet.</p>
          </Reveal>

          <Reveal delay={90}>
            <HeroVisual />
          </Reveal>
        </div>
      </section>

      {/* ================= how it works ================= */}
      <section className="section section-subtle" id="how-it-works">
        <GridBackground fade="bottom" strong />
        <div className="shell">
          <Reveal>
            <SectionHeading
              eyebrow="How it works"
              title="Five steps, and only one of them is hidden."
              lede="Everything except the split itself happens in the open — on your own machine, or on chain, where you can watch it."
            />
          </Reveal>
          <Reveal>
            <ProcessDiagram />
          </Reveal>
        </div>
      </section>

      {/* ================= use cases ================= */}
      <section className="section" id="use-cases">
        <div className="shell">
          <Reveal>
            <SectionHeading
              eyebrow="Where people use it"
              title="Anywhere the total should be public and the breakdown should not."
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

      {/* ================= why Flare ================= */}
      <section className="section" id="why-flare">
        <div className="shell">
          <Reveal>
            <SectionHeading
              eyebrow="Why Flare"
              title="Sealed hardware is only half of it. Something has to check the seal."
              lede="Every design like this reaches the same question: who confirms the signature came from genuine hardware running the published program? The answer decides whether anyone is left to trust."
            />
          </Reveal>

          <Reveal>
            <WhyFlare />
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
              title="Don't trust the computation. Check it."
              lede="A private backend that asks to be trusted hasn't solved the problem, it has moved it. Every round publishes enough for a stranger to check the work: which program ran, that it ran in real hardware, and that the signature came from that hardware."
            />
            <p className="note">
              The report re-derives every check in your browser, independently of the contract. Two
              implementations agreeing is evidence; one checking itself is not.
            </p>
          </Reveal>

          <Reveal delay={80}>
            <VerificationPanel />
          </Reveal>
        </div>

        <div className="shell" style={{ marginTop: "var(--s12)" }}>
          <Reveal className="explorer-cta">
            <div>
              <SectionHeading
                eyebrow="Explorer"
                title="Look up any round."
                lede="Open a round and inspect what happened: the code identity, the attestation, the signature, and the arithmetic the contract enforced."
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
                  placeholder="Round number, e.g. 1"
                  inputMode="numeric"
                  autoComplete="off"
                />
                <button className="btn btn-primary" type="submit" disabled={!valid}>
                  <IconSearch size={15} />
                  Open
                </button>
              </form>
              <p className="hint">
                Rounds are numbered from 0. <Link href="/verify">Browse them all →</Link>
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================= evidence ================= */}
      <section className="section" id="evidence">
        <div className="shell">
          <Reveal>
            <SectionHeading
              eyebrow="Check it yourself"
              title="Everything here has something behind it."
              lede="Nothing on this page asks to be taken on trust, so here is where each part of it can be inspected."
              center
            />
          </Reveal>

          <Reveal className="evidence-grid">
            <article className="evidence-card">
              <div className="evidence-head">
                <IconBank size={17} />
                <h3>The contract</h3>
              </div>
              <p>
                Live on Coston2. Round state, the registered hardware address and the program id
                are all public storage — read them without a wallet.
              </p>
              {CONTRACT ? (
                <a
                  className="evidence-link"
                  href={`${EXPLORER}/address/${CONTRACT}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on the explorer
                  <IconExternal size={12} />
                </a>
              ) : (
                <span className="hint">NEXT_PUBLIC_FIDENSUR_CONTRACT is not set.</span>
              )}
            </article>

            <article className="evidence-card">
              <div className="evidence-head">
                <IconBadgeCheck size={17} />
                <h3>A completed round</h3>
              </div>
              <p>
                A real round, computed in the enclave and settled on-chain. The report re-derives
                the signature in your browser rather than asking the contract whether it agrees
                with itself.
              </p>
              <Link className="evidence-link" href="/verify/1">
                Open the report
                <IconArrowRight size={12} />
              </Link>
            </article>

            <article className="evidence-card">
              <div className="evidence-head">
                <IconDocument size={17} />
                <h3>The source</h3>
              </div>
              <p>
                Contracts, the allocation engine, and this site. The README states plainly which
                parts are proven by a passing test run and which are not.
              </p>
              <a className="evidence-link" href={REPO} target="_blank" rel="noreferrer">
                Read the repository
                <IconExternal size={12} />
              </a>
            </article>

            <article className="evidence-card">
              <div className="evidence-head">
                <IconChip size={17} />
                <h3>The build</h3>
              </div>
              <p>
                The enclave image is reproducible: CI builds it on two independently provisioned
                machines and compares digests. Rebuild the published commit and check the hash for
                yourself.
              </p>
              <pre>
                <code>{`docker build --build-arg \\
  SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \\
  -t fidensur-extension ./extension`}</code>
              </pre>
            </article>
          </Reveal>

          {/* The two caveats, kept together and kept late — where someone deciding will read them
              rather than scroll past. Both were previously buried in sections that no longer
              exist; neither was dropped. */}
          <Reveal>
            <div className="limits">
              <h3>What this does not do</h3>

              <p>
                <strong>Claiming makes your own amount public.</strong> A transfer of tokens to an
                address is visible like any other transfer. Fidensur keeps every unclaimed
                allocation private and never reveals the distribution as a whole, but it cannot
                make a completed payment invisible. This is not anonymity, and anyone claiming
                otherwise for this kind of system is overselling it.
              </p>

              <p>
                <strong>This deployment uses simulated attestation.</strong> The enclave is an
                ordinary container rather than confidential-compute hardware, so its code hash is a
                placeholder rather than a real measurement. Every mechanism above genuinely runs;
                what is missing is the hardware guarantee that nobody could have looked. Moving to
                real attestation is a deployment change, not a code change — and the verification
                report checks for this and marks it <strong>FAIL</strong> rather than hiding it.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================= final CTA ================= */}
      <section className="section final-cta">
        <GridBackground fade="center" strong />
        <div className="shell">
          <Reveal>
            <h2>Keep the total public. Keep the breakdown private.</h2>
            <div className="btn-group">
              <Link className="btn btn-primary btn-lg" href="/dashboard">
                Open the app
                <IconArrowRight size={16} className="btn-arrow" />
              </Link>
              <Link className="btn btn-secondary btn-lg" href="/verify">
                Browse verified rounds
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </main>
  );
}
