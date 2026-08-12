/**
 * Icon set.
 *
 * Inline SVG rather than an icon package: the whole set below is smaller than the dependency
 * would be, and every glyph inherits `currentColor` and the surrounding font size, which is what
 * makes the dark palette free — there is no colour to re-theme.
 *
 * One grid (24×24), one stroke weight (1.5), one join style. Icons that disagree on those three
 * things read as borrowed from different products, which is exactly the impression to avoid.
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

/** The check used in verification marks — its path length is tuned for the draw-on animation. */
export function IconCheckAnimated(props: IconProps) {
  return (
    <Svg {...props}>
      <path className="tick-path" d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  );
}

export function IconArrowDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </Svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </Svg>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 20}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 20}>
      <path d="M6 6 18 18M18 6 6 18" />
    </Svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

export function IconShieldCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 5 6v5.5c0 4 2.8 7.6 7 9.5 4.2-1.9 7-5.5 7-9.5V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  );
}

export function IconChip(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </Svg>
  );
}

export function IconLink(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 13a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.3 6" />
      <path d="M14 11a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7L12.7 18" />
    </Svg>
  );
}

export function IconExternal(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 4h6v6M20 4l-8 8" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </Svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

export function IconList(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </Svg>
  );
}

export function IconBadgeCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3 2.1 1.6 2.6-.3 1 2.4 2.4 1-.3 2.6L21.4 12l-1.6 2.1.3 2.6-2.4 1-1 2.4-2.6-.3L12 21.4l-2.1-1.6-2.6.3-1-2.4-2.4-1 .3-2.6L2.6 12l1.6-2.1-.3-2.6 2.4-1 1-2.4 2.6.3L12 2.6Z" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  );
}

export function IconWallet(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 8V6.5A1.5 1.5 0 0 0 18.5 5H5.5A1.5 1.5 0 0 0 4 6.5v11A1.5 1.5 0 0 0 5.5 19h13a1.5 1.5 0 0 0 1.5-1.5V16" />
      <path d="M20 8h-4a2 2 0 0 0 0 8h4a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1Z" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3.25 3.25 0 0 1 0 6.3M17 15.2a5.5 5.5 0 0 1 3.5 3.8" />
    </Svg>
  );
}

export function IconCoins(props: IconProps) {
  return (
    <Svg {...props}>
      <ellipse cx="12" cy="7" rx="7" ry="3" />
      <path d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7" />
      <path d="M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
    </Svg>
  );
}

export function IconDocument(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </Svg>
  );
}

export function IconGift(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="8.5" width="17" height="4" rx="1" />
      <path d="M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5M12 8.5v12" />
      <path d="M12 8.5S10.8 4 8.8 4a2.2 2.2 0 0 0 0 4.5M12 8.5S13.2 4 15.2 4a2.2 2.2 0 0 1 0 4.5" />
    </Svg>
  );
}

export function IconTarget(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.75" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconAcademic(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 5 9 4-9 4-9-4 9-4Z" />
      <path d="M7 11v4.5c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V11M21 9v5" />
    </Svg>
  );
}

export function IconBank(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 4 8 4H4l8-4Z" />
      <path d="M6.5 9v8M10.5 9v8M13.5 9v8M17.5 9v8M4 20h16" />
    </Svg>
  );
}

export function IconInbox(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 13h4l1.5 3h5L16 13h4" />
      <path d="M6.2 5h11.6a2 2 0 0 1 1.9 1.4L21 13v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4l1.3-6.6A2 2 0 0 1 6.2 5Z" />
    </Svg>
  );
}
