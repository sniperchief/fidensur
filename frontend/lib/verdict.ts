/**
 * The report's overall verdict, derived rather than asserted.
 *
 * A verification page that renders a green tick because someone typed one is worse than no
 * verification page at all — it teaches a reader that the tick means something, and then spends
 * that credibility on nothing. So this file computes the headline from the same check results the
 * body of the report displays, and it cannot say "verified" unless every check ran and passed.
 *
 * ## Five states, not two
 *
 * The temptation is pass/fail. Real reports have three more:
 *
 *   - **unavailable** — the proxy is offline, or the signed result has aged out of it. Nothing is
 *     wrong; nothing is confirmed either. Collapsing this into "fail" cries wolf, and collapsing
 *     it into "pass" is a lie.
 *   - **manual** — reproducing the build is the one check that requires the reader to run
 *     something. The page cannot do it and says so, rather than quietly scoring itself.
 *   - **info** — sections that present values rather than assert anything. They are excluded from
 *     the counts entirely, because inflating a pass count with rows that could never fail is the
 *     oldest trick in this genre.
 *
 * Only pass, fail and unavailable are counted.
 */

import type { Round } from "./contracts";
import type { AttestationVerdict, VerificationSteps } from "./verify";

export type CheckState = "pass" | "fail" | "unavailable" | "manual" | "info";

export interface SectionVerdict {
  n: number;
  /** Short enough for the rail; the section keeps the full question. */
  label: string;
  state: CheckState;
  /** One line, for the rail's tooltip and the mobile strip. */
  note: string;
}

export interface ReportVerdict {
  sections: SectionVerdict[];
  passed: number;
  failed: number;
  unavailable: number;
  /**
   * `simulated` is a *kind* of failure, not an excuse for one.
   *
   * A report that renders "Not verified" identically whether the cause is a testnet enclave or a
   * signature that does not match is accurate and useless — a reader skimming it assumes the
   * system is broken and never reaches the reasoning. Splitting the two costs nothing in honesty:
   * the check still failed, it is still counted as a failure, and the headline still refuses to
   * say verified. It only names *which* failure.
   *
   * The split is narrow on purpose. It applies when the attestation is simulated **and** the
   * extension id still matches its on-chain registration — a machine reporting the wrong
   * extension is a genuine integrity problem and stays `failed`.
   */
  overall: "verified" | "failed" | "partial" | "simulated";
  headline: string;
  detail: string;
  /** Extra context, currently only for the simulated case. */
  note?: string;
}

export function deriveVerdict(input: {
  round: Round;
  attestationAvailable: boolean;
  attestation: AttestationVerdict | undefined;
  steps: VerificationSteps | undefined;
  resultAvailable: boolean;
}): ReportVerdict {
  const { round, attestationAvailable, attestation, steps, resultAvailable } = input;

  // 1 — did it run in a real TEE?
  let enclave: SectionVerdict;
  if (!attestationAvailable || !attestation) {
    enclave = {
      n: 1,
      label: "Real enclave",
      state: "unavailable",
      note: "No attestation report reachable from here.",
    };
  } else if (attestation.trustworthy) {
    enclave = {
      n: 1,
      label: "Real enclave",
      state: "pass",
      note: "Attested platform, measured code hash, registered extension.",
    };
  } else {
    enclave = {
      n: 1,
      label: "Real enclave",
      state: "fail",
      note: attestation.isSimulatedCodeHash
        ? "Simulated attestation — this is not a genuine enclave measurement."
        : "The attestation report does not match a registered production enclave.",
    };
  }

  // 2 — is the running code the published code? Nobody can answer this for you.
  const reproducible: SectionVerdict = {
    n: 2,
    label: "Published code",
    state: attestationAvailable ? "manual" : "unavailable",
    note: attestationAvailable
      ? "Requires rebuilding the published commit yourself."
      : "No attested code hash to compare a rebuild against.",
  };

  // 3 — is the signature valid?
  let signature: SectionVerdict;
  if (!resultAvailable || !steps) {
    signature = {
      n: 3,
      label: "TEE signature",
      state: "unavailable",
      note: "No signed result available from the proxy for this round.",
    };
  } else if (steps.signerOk && steps.statusOk) {
    signature = {
      n: 3,
      label: "TEE signature",
      state: "pass",
      note: "Recovered signer matches the registered TEE.",
    };
  } else {
    signature = {
      n: 3,
      label: "TEE signature",
      state: "fail",
      // Reaching here with a good signer means the status was the problem, and vice versa —
      // naming which one keeps the rail from saying "signature failed" about a valid signature
      // over a result the enclave itself marked as failed.
      note: steps.signerOk
        ? "The signature is valid, but the enclave reported a failed computation."
        : "The recovered signer is not the registered TEE.",
    };
  }

  // 4 — does the arithmetic hold? Always answerable: it is all public chain state.
  const arithmeticOk =
    round.totalAllocated <= round.funded && round.totalClaimed <= round.totalAllocated;
  const arithmetic: SectionVerdict = {
    n: 4,
    label: "Arithmetic",
    state: arithmeticOk ? "pass" : "fail",
    note: arithmeticOk
      ? "Allocated does not exceed funded; claimed does not exceed allocated."
      : "The published totals do not hold together.",
  };

  const sections: SectionVerdict[] = [
    enclave,
    reproducible,
    signature,
    arithmetic,
    {
      n: 5,
      label: "Committed policy",
      state: "info",
      note: "The commitment is recorded before the ciphertext is dispatched.",
    },
    {
      n: 6,
      label: "What the root commits to",
      state: "info",
      note: "The Merkle root fixes every allocation without publishing any.",
    },
  ];

  const counted = sections.filter((s) => s.state === "pass" || s.state === "fail" || s.state === "unavailable");
  const passed = counted.filter((s) => s.state === "pass").length;
  const failed = counted.filter((s) => s.state === "fail").length;
  const unavailable = counted.filter((s) => s.state === "unavailable").length;

  // The attestation being simulated is the expected state of a testnet deployment, and is a
  // different thing from a check that failed because something is wrong. A wrong extension id is
  // not covered — that is a real mismatch and stays an outright failure.
  const simulationOnly =
    failed === 1 &&
    enclave.state === "fail" &&
    attestation?.isSimulatedCodeHash === true &&
    attestation.matchesRegisteredExtension;

  // A failure outranks everything. An unverifiable check outranks a clean sweep of the rest —
  // "verified" has to mean every check ran, not every check that happened to be convenient.
  const overall =
    failed > 0
      ? simulationOnly
        ? "simulated"
        : "failed"
      : unavailable > 0
        ? "partial"
        : "verified";

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const headline =
    overall === "verified"
      ? "Verified"
      : overall === "simulated"
        ? "Not verified — simulated enclave"
        : overall === "failed"
          ? "Not verified"
          : "Partially verified";

  const detail =
    overall === "verified"
      ? "Every check this page can make passed."
      : overall === "simulated"
        ? `Every cryptographic check passed. The one failure is the hardware itself: ` +
          `attestation on this deployment is simulated, so genuine isolation cannot be established.`
        : overall === "failed"
          ? `${plural(failed, "check")} failed. Read the sections below before relying on this round.`
          : `${plural(passed, "check")} passed; ${unavailable} could not be checked from here.`;

  const note =
    overall === "simulated"
      ? "The enclave, the encryption and the signature are all real and all verified. What is " +
        "missing is proof that the machine running them was hardware-isolated — which is a " +
        "deployment configuration, not a change to any of the code above."
      : undefined;

  return { sections, passed, failed, unavailable, overall, headline, detail, note };
}
