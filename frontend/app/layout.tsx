import type { Metadata, Viewport } from "next";

import { Chrome } from "@/components/Chrome";
import { Providers } from "./providers";

import "./globals.css";

/**
 * ## No webfont
 *
 * This previously loaded Inter through `next/font/google`. That fetches from Google's servers at
 * *compile* time — including on every cold dev compile — with a 3s timeout and three retries, so
 * on a slow or intermittent connection it does not degrade, it blocks: the page never finishes
 * compiling and the terminal fills with "Request timed out after 3000ms".
 *
 * The typeface is not worth making the build depend on someone else's network. `--sans` in
 * globals.css names Inter first, so a machine that has it installed still gets it, and everything
 * else falls through to the platform UI face — Segoe UI Variable on Windows, SF Pro on macOS —
 * which is what the product was already specifying before this rewrite.
 *
 * To bring Inter back properly, vendor the woff2 files into the repo and use `next/font/local`,
 * which self-hosts with no network access at any stage. `--sans` already prefers `--font-sans`
 * when it is defined, so that change is confined to this file.
 */

export const metadata: Metadata = {
  title: {
    default: "Fidensur — private treasury operations, publicly verifiable execution",
    template: "%s · Fidensur",
  },
  description:
    "Fidensur uses Flare Confidential Compute to process sensitive treasury allocations inside a Trusted Execution Environment while keeping the computation verifiable.",
  applicationName: "Fidensur",
  openGraph: {
    title: "Fidensur",
    description: "Allocate funds privately. Prove the computation publicly.",
    siteName: "Fidensur",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0d14" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Providers>
          <Chrome>{children}</Chrome>
        </Providers>
      </body>
    </html>
  );
}
