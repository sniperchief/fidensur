import type { Metadata } from "next";
import Link from "next/link";

import { ConnectButton } from "@/components/Wallet";
import { Providers } from "./providers";

import "./globals.css";

export const metadata: Metadata = {
  title: "Fidensur",
  description: "Allocate funds privately. Prove the computation publicly.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="site-header">
            <Link href="/" className="brand">
              Fidensur
            </Link>
            <nav>
              <Link href="/org">Organization</Link>
              <Link href="/claim">Claim</Link>
              <Link href="/verify">Verify</Link>
            </nav>
            <ConnectButton />
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}
