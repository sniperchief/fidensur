import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Fidensur",
  description: "Allocate funds privately. Prove the computation publicly.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
