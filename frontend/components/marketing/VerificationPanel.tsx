/**
 * The verification report, as an illustration.
 *
 * ## Why this file says "illustration" three times
 *
 * Everything on this panel is a fixed string. It is a picture of what a report looks like when
 * every check passes — not a report, and not connected to anything.
 *
 * That distinction is the whole product. A marketing page that renders a green VERIFIED badge
 * with no computation behind it, on a site whose pitch is "don't trust the computation, verify
 * it", has already conceded the argument. So the panel is framed as a preview, its footer says
 * plainly what it is, and it links to the real thing — which derives every line from chain state
 * and the enclave's attestation report, and which will happily render a page full of "cannot be
 * checked from here" when the proxy is offline or the attestation is simulated.
 *
 * Live data belongs on /verify/[round]. Nothing here should ever be wired to a chain read: the
 * moment it is, a visitor cannot tell which of the two they are looking at.
 */

import { IconCheckAnimated } from "@/components/ui/Icons";

/** Illustrative values. Not read from anywhere, and deliberately not real hashes. */
const ROWS: { label: string; value: string; mono?: boolean; ok?: boolean }[] = [
  { label: "Extension", value: "Fidensur Allocation Engine" },
  { label: "TEE", value: "Registered · GCP_AMD_SEV" },
  { label: "Code hash", value: "0x8f2c41…6ba91d", mono: true },
  { label: "Source", value: "github.com/…/fidensur", mono: true },
  { label: "Attestation", value: "Signature recovered" },
  { label: "Code match", value: "Published = deployed" },
  { label: "Execution", value: "Genuine enclave" },
];

export function VerificationPanel() {
  return (
    <figure className="verify-panel" style={{ margin: 0 }}>
      <div className="verify-panel-head">
        <span className="window-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="panel-title">Fidensur verification</span>
      </div>

      <div className="verify-panel-body">
        <span className="verdict">
          <span className="verdict-mark" aria-hidden="true">
            <IconCheckAnimated size={13} />
          </span>
          VERIFIED
        </span>
        <p
          style={{
            margin: "var(--s3) 0 0",
            fontSize: "var(--fs-sm)",
            color: "var(--fg-muted)",
          }}
        >
          This confidential computation matches its published identity.
        </p>

        <div className="verify-rows">
          {ROWS.map((row) => (
            <div className="verify-row" key={row.label}>
              <span className="row-label">{row.label}</span>
              <span className={row.mono ? "row-value mono" : "row-value"}>{row.value}</span>
              <span className="row-mark" data-ok={row.ok ?? true}>
                <IconCheckAnimated size={11} />
                PASS
              </span>
            </div>
          ))}
        </div>

        {/* Reproducible builds are the check the page cannot do for you, so it shows both sides
            of the comparison rather than only the conclusion. */}
        <div className="match-grid">
          <div className="match-side">
            <span className="flow-label">Published source</span>
            <code>0x8f2c41…6ba91d</code>
          </div>
          <span className="match-eq" aria-hidden="true">
            =
          </span>
          <div className="match-side">
            <span className="flow-label">Attested image</span>
            <code>0x8f2c41…6ba91d</code>
          </div>
        </div>
      </div>

      <figcaption className="verify-panel-foot">
        <p>
          Illustration of a passing report. A live report derives every line from chain state and
          the enclave&rsquo;s attestation — and says so when a check cannot be made.
        </p>
      </figcaption>
    </figure>
  );
}
