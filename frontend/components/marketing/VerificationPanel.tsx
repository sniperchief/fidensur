/**
 * The verification report, as an illustration.
 *
 * ## Why there is no VERIFIED badge on it
 *
 * There used to be: a large green tick, seven rows all marked PASS. Every value was a fixed
 * string, and a footnote said so.
 *
 * The problem was not the footnote, it was the arithmetic. `deriveVerdict` refuses to call this
 * deployment verified — attestation here is simulated, so the attestation check genuinely fails —
 * which meant a visitor read "✓ VERIFIED" on the homepage, clicked through to a real report, and
 * got the opposite. A footnote loses to a green badge, and the contradiction reads as overselling,
 * which is the one accusation this product cannot survive.
 *
 * So the illustration no longer asserts an outcome at all. Its job is to show **what a report
 * contains** — the checks, their evidence, and the three different things a row can say — which is
 * more informative than a verdict and cannot contradict the live page. The mixed states are the
 * honest ones for this deployment, and they demonstrate the property actually worth selling: the
 * report tells you when it cannot verify something.
 *
 * Nothing here is fetched. Live data belongs on /verify/[round]; the moment this is wired to a
 * chain read, a visitor can no longer tell which of the two they are looking at.
 */

import { IconCheck, IconClose } from "@/components/ui/Icons";

/** Illustrative. Mirrors the six questions the real report asks, with this deployment's answers. */
const ROWS: {
  label: string;
  value: string;
  mono?: boolean;
  state: "pass" | "fail" | "manual" | "info";
  mark: string;
}[] = [
  { label: "Real enclave", value: "Simulated attestation", state: "fail", mark: "FAIL" },
  { label: "Published code", value: "Rebuild to confirm", state: "manual", mark: "YOU" },
  { label: "TEE signature", value: "Signer matches registry", state: "pass", mark: "PASS" },
  { label: "Arithmetic", value: "Allocated ≤ funded", state: "pass", mark: "PASS" },
  { label: "Committed policy", value: "0x8f2c41…6ba91d", mono: true, state: "info", mark: "—" },
  { label: "Merkle root", value: "0x41d907…ac5b32", mono: true, state: "info", mark: "—" },
];

export function VerificationPanel() {
  return (
    <figure className="verify-panel">
      <div className="verify-panel-head">
        <span className="window-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="panel-title">Fidensur verification · round 1</span>
      </div>

      <div className="verify-panel-body">
        {/* Left: the one check the page cannot make for you, shown as the comparison it is. */}
        <div className="panel-pane panel-pane-left">
          <span className="flow-label">Code identity</span>

          <div className="match-stack">
            <div>
              <span className="match-caption">Published source</span>
              <code>0x8f2c41…6ba91d</code>
            </div>
            <span className="match-eq" aria-hidden="true">
              =
            </span>
            <div>
              <span className="match-caption">Attested image</span>
              <code>0x8f2c41…6ba91d</code>
            </div>
          </div>

          <p className="pane-note">
            The image builds bit-for-bit identically on independent machines. Rebuild the published
            commit and the hash the enclave attests to is the hash you get.
          </p>
        </div>

        {/* Right: what each question answered. */}
        <div className="panel-pane">
          <div className="verify-rows">
            {ROWS.map((row) => (
              <div className="verify-row" key={row.label}>
                <span className="row-label">{row.label}</span>
                <span className={row.mono ? "row-value mono" : "row-value"}>{row.value}</span>
                <span className="rail-mark" data-state={row.state}>
                  {row.state === "pass" ? (
                    <IconCheck size={11} />
                  ) : row.state === "fail" ? (
                    <IconClose size={11} />
                  ) : null}
                  {row.mark}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <figcaption className="verify-panel-foot">
        <p>
          An illustration of a report&rsquo;s structure — not a live one. Attestation on this
          testnet deployment really is simulated, and a real report marks it{" "}
          <strong>FAIL</strong> rather than hiding it. <strong>YOU</strong> marks the one check no
          page can make on your behalf.
        </p>
      </figcaption>
    </figure>
  );
}
