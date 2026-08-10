/**
 * Client-side providers.
 *
 * Split into its own file because `layout.tsx` is a server component and must stay one — marking
 * the layout `"use client"` would opt the entire tree out of server rendering for no benefit.
 */

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "@/lib/wagmi";

export function Providers({ children }: { children: React.ReactNode }) {
  // Created in state, not at module scope: a module-level client is shared across every render in
  // development's fast-refresh and would leak cached chain reads between reloads.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain state here is money — a stale balance or round status invites a user to send a
            // transaction that cannot succeed. Refetch rather than serve a cached answer.
            staleTime: 0,
            retry: 1,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
