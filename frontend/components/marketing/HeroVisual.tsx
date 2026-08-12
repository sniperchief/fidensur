/**
 * The hero diagram.
 *
 * Four nodes and three connectors: money in, computation nobody can see, a signature anyone can
 * check, money out. If a visitor reads nothing else on the page, this is the thing that has to
 * carry the product — so it is built from the same cards, borders and status badges the real
 * application uses, rather than an illustration of a product that does not look like this.
 *
 * ## The redacted band
 *
 * It is deliberately not a blurred list of names and amounts. A blur implies there is something
 * underneath to recover, and on a screenshot that would be a lie about what the system does — the
 * plaintext is not present in a weakened form, it is not present at all. Flat bars of no
 * particular width say "withheld" without pretending to be data.
 *
 * The figures are illustrative. Real numbers appear on /dashboard and /verify, read from chain.
 */

import { Badge } from "@/components/ui/StatusBadge";
import { IconCheckAnimated, IconLock, IconUsers } from "@/components/ui/Icons";

export function HeroVisual() {
  return (
    <div
      className="hero-visual"
      role="img"
      aria-label="A treasury of 50,000 FLR flows into a confidential computation whose allocation stays private, produces an attested and verified result, and settles to 24 recipients."
    >
      <div className="flow-node" data-emphasis="high">
        <span className="flow-label">Treasury</span>
        <div className="flow-row">
          <span className="flow-value">
            50,000<span className="unit">FLR</span>
          </span>
          <Badge kind="neutral" dot={false}>
            Funded
          </Badge>
        </div>
        <span className="flow-sub">Held by the round contract, publicly visible</span>
      </div>

      {/* Staggered so the pips read as one thing moving down the pipeline rather than three
          things blinking in unison. */}
      <div className="flow-link" style={{ "--pip-delay": "0s" } as React.CSSProperties} aria-hidden="true" />

      <div className="flow-node" data-tone="dark" data-emphasis="high">
        <span className="flow-label">Confidential compute</span>
        <div className="flow-row">
          <span className="flow-value value-sm">Allocation policy</span>
          <IconLock size={15} />
        </div>
        <div className="redacted" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} />
          ))}
        </div>
        <span className="flow-sub">Decrypted and evaluated only inside the enclave</span>
      </div>

      <div className="flow-link" style={{ "--pip-delay": "0.5s" } as React.CSSProperties} aria-hidden="true" />

      <div className="flow-node" data-tone="pass">
        <span className="flow-label">Attestation</span>
        <div className="flow-row">
          <span className="verdict verdict-sm">
            <span className="verdict-mark" aria-hidden="true">
              <IconCheckAnimated size={12} />
            </span>
            VERIFIED
          </span>
        </div>
        <span className="flow-sub">Merkle root, total and count — signed by an attested TEE</span>
      </div>

      <div className="flow-link" style={{ "--pip-delay": "1s" } as React.CSSProperties} aria-hidden="true" />

      <div className="flow-node">
        <span className="flow-label">Distribution</span>
        <div className="flow-row">
          <span className="flow-value value-sm">
            <IconUsers size={15} style={{ verticalAlign: "-2px", marginRight: "0.4rem" }} />
            24 recipients
          </span>
          <Badge kind="pass" dot={false}>
            Claimable
          </Badge>
        </div>
        <span className="flow-sub">Each proves their own entry. Nobody learns anyone else&rsquo;s.</span>
      </div>
    </div>
  );
}
