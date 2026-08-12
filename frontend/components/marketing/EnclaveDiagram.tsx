/**
 * What happens inside the TEE.
 *
 * Private inputs go in at the top, an attested result comes out at the bottom, and between them
 * is a dark box listing what runs there. The box is the only genuinely opaque thing on the page,
 * which is the point: everything else in the product is inspectable, and the reader should be
 * able to see exactly how much is not.
 *
 * The operations listed are the ones the Go engine actually performs, in order. Naming them is
 * not a leak — the *code* is published and reproducible, and only the inputs are secret. Vague
 * language here ("proprietary logic") would suggest the opposite trust model.
 */

import { IconArrowDown, IconLock, IconShieldCheck } from "@/components/ui/Icons";

const OPS = [
  { index: "01", label: "Decrypt the committed policy", state: "sealed" },
  { index: "02", label: "Validate against the round's rules", state: "checked" },
  { index: "03", label: "Apply the allocation logic", state: "private" },
  { index: "04", label: "Build the Merkle tree", state: "committed" },
  { index: "05", label: "Sign the aggregate", state: "attested" },
];

export function EnclaveDiagram() {
  return (
    <div className="enclave">
      <div className="io-node">
        <span className="flow-label">Private inputs</span>
        <IconLock size={14} />
      </div>

      <div className="flow-link" style={{ "--pip-delay": "0s" } as React.CSSProperties} aria-hidden="true" />

      <div className="enclave-box">
        <div className="enclave-head">
          <span className="enclave-title">Flare Confidential Compute</span>
          <span className="enclave-seal">
            <IconShieldCheck size={13} />
            Sealed
          </span>
        </div>

        <ol className="enclave-ops">
          {OPS.map((op) => (
            <li key={op.index}>
              <span className="op-index">{op.index}</span>
              {op.label}
              <span className="op-state">{op.state}</span>
            </li>
          ))}
        </ol>

        <p className="enclave-note">
          The image running here is bit-for-bit reproducible. Rebuild the published commit and the
          hash the enclave attests to is the hash you get.
        </p>
      </div>

      <div className="flow-link" style={{ "--pip-delay": "0.6s" } as React.CSSProperties} aria-hidden="true" />

      <div className="io-node" data-tone="pass">
        <span className="flow-label">Attested result</span>
        <IconArrowDown size={14} style={{ transform: "rotate(-90deg)" }} />
      </div>
    </div>
  );
}
