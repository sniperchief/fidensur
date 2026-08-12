/**
 * The Fidensur mark.
 *
 * A stroked rounded square with a solid core rotated inside it: a boundary you can see, holding
 * something you cannot. That is the entire product in one glyph, and it survives being 20px tall
 * in a header, which a literal illustration of an enclave would not.
 *
 * Drawn in `currentColor` so it needs no dark-mode variant and inherits whatever the surrounding
 * text is doing.
 */

import Link from "next/link";

export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.75" y="2.75" width="18.5" height="18.5" rx="5.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="8.6" y="8.6" width="6.8" height="6.8" rx="1.6" fill="currentColor" transform="rotate(45 12 12)" />
    </svg>
  );
}

export function Brand({ href = "/", label = "Fidensur" }: { href?: string; label?: string }) {
  return (
    <Link href={href} className="brand">
      <BrandMark />
      {label}
    </Link>
  );
}
