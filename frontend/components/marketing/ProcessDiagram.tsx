/**
 * How Fidensur works, in five steps.
 *
 * Horizontal on desktop with a hairline rail through the step markers; a vertical timeline below
 * 768px, where the rail rotates to run down the left. Both are the same DOM — the rail is a
 * pseudo-element on each step, so nothing is duplicated and nothing is hidden at one size.
 *
 * Each step carries a small technical figure rather than an icon. The figures are literal about
 * what changes at that step: readable fields become an opaque block at step 02 and stay opaque
 * until the signature at step 04. Somebody who only looks at the pictures should still come away
 * with the right idea about where the privacy boundary is.
 */

const STEPS = [
  {
    n: "01",
    title: "Create the round",
    body: "The organization opens a round, names the token and sets a claim window, then funds it. The amount is public; nothing about the split is decided yet.",
    figure: (
      <>
        <span className="figure-line" data-w="full" data-tone="ghost" />
        <span className="figure-line" data-w="wide" data-tone="ghost" />
        <span className="figure-line" data-w="short" data-tone="accent" />
        <span className="figure-caption">token · window</span>
      </>
    ),
  },
  {
    n: "02",
    title: "Submit confidential inputs",
    body: "The allocation policy is composed in the browser and encrypted to the enclave's public key. Only a hash of the ciphertext is recorded on-chain.",
    figure: (
      <>
        <div className="redacted" style={{ marginTop: 0 }}>
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} />
          ))}
        </div>
        <span className="figure-caption">ciphertext</span>
      </>
    ),
  },
  {
    n: "03",
    title: "Compute inside FCC",
    body: "A Trusted Execution Environment decrypts the policy, applies the allocation rules, and builds a Merkle tree over the result. The operator cannot read either.",
    figure: (
      <>
        <div className="figure-enclave">
          <span />
        </div>
        <span className="figure-caption">tee execution</span>
      </>
    ),
  },
  {
    n: "04",
    title: "Verify the attestation",
    body: "The enclave signs an aggregate — root, total, count — with its attested key. The contract recovers the signer; your browser recovers it again, independently.",
    figure: (
      <>
        <span className="figure-line" data-w="full" data-tone="pass" />
        <span className="figure-line" data-w="mid" data-tone="ghost" />
        <span className="figure-caption">signature ✓</span>
      </>
    ),
  },
  {
    n: "05",
    title: "Execute settlement",
    body: "Recipients prove their own entry against the root and claim. No allocation is ever published, and no recipient learns another's.",
    figure: (
      <>
        <div className="figure-dots">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} />
          ))}
        </div>
        <span className="figure-caption">settled</span>
      </>
    ),
  },
];

export function ProcessDiagram() {
  return (
    <ol className="process">
      {STEPS.map((step) => (
        <li className="process-step" key={step.n}>
          <span className="process-node" aria-hidden="true" />
          <span className="process-num">{step.n}</span>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
          <div className="process-figure" aria-hidden="true">
            {step.figure}
          </div>
        </li>
      ))}
    </ol>
  );
}
