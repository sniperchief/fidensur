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
    title: "Put the money in",
    body: "You open a round and fund it. The amount is public. Nothing about who gets what is decided yet.",
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
    title: "Write the list privately",
    body: "You list who gets what in your browser. It is encrypted before it leaves the page, and only a fingerprint of it goes on-chain.",
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
    title: "Sealed hardware does the maths",
    body: "It opens the list, works out each share, and builds a proof. Whoever runs that machine cannot read any of it.",
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
    title: "The chain checks the signature",
    body: "The hardware signs its answer with a key tied to the exact program it ran. The contract checks that signature before accepting anything.",
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
    title: "People claim their share",
    body: "Each person proves their own entry and takes their money. Nobody learns anyone else's amount.",
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
