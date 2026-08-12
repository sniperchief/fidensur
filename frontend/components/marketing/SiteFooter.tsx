/**
 * Footer.
 *
 * Three columns and a line of small print. The small print is not filler: it states that this
 * deployment runs on a testnet with simulated attestation, which is the single caveat a visitor
 * most needs and is least likely to go looking for. Putting it here means it is on every page,
 * not only the one that happens to mention it.
 */

import Link from "next/link";

import { BrandMark } from "@/components/Brand";
import { COSTON2 } from "@/lib/contracts";

const CONTRACT = process.env.NEXT_PUBLIC_FIDENSUR_CONTRACT ?? "";
const REPO = "https://github.com/sniperchief/fidensur";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Allocations", href: "/dashboard/allocations" },
      { label: "Verification explorer", href: "/verify" },
      { label: "Recipient claim", href: "/claim" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Documentation", href: `${REPO}#readme`, external: true },
      { label: "Architecture", href: `${REPO}/blob/main/docs/architecture.md`, external: true },
      { label: "GitHub", href: REPO, external: true },
    ],
  },
  {
    heading: "Network",
    links: [
      { label: "Flare", href: "https://flare.network", external: true },
      {
        label: "Confidential Compute",
        href: "https://dev.flare.network/fcc/overview",
        external: true,
      },
      {
        label: "Coston2 explorer",
        href: COSTON2.blockExplorers.default.url,
        external: true,
      },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell">
        <div className="footer-top">
          <div className="footer-brand">
            <Link href="/" className="brand">
              <BrandMark />
              Fidensur
            </Link>
            <p>Allocate funds privately. Prove the computation publicly.</p>
          </div>

          {COLUMNS.map((column) => (
            <div className="footer-col" key={column.heading}>
              <h3>{column.heading}</h3>
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>
                    {"external" in link && link.external ? (
                      <a href={link.href} target="_blank" rel="noreferrer">
                        {link.label}
                      </a>
                    ) : (
                      <Link href={link.href}>{link.label}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="footer-bottom">
          {/* No year. These pages are statically prerendered, so `new Date()` here would bake the
              build year into the HTML and then disagree with the client on the first render after
              New Year — a hydration mismatch for a string that carries no information. */}
          <p>© Fidensur</p>
          <p>
            {COSTON2.name} · chain {COSTON2.id}
            {CONTRACT && (
              <>
                {" · "}
                <a
                  href={`${COSTON2.blockExplorers.default.url}/address/${CONTRACT}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  contract
                </a>
              </>
            )}{" "}
            · testnet deployment with simulated attestation
          </p>
        </div>
      </div>
    </footer>
  );
}
