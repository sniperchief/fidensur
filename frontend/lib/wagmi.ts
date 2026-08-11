/**
 * Wallet configuration.
 *
 * Injected connectors only — MetaMask, Rabby, Brave, anything that puts an EIP-1193 provider on
 * `window.ethereum`. WalletConnect is deliberately absent: it requires a project id registered with
 * a third party and routes session traffic through their relay. For an application whose entire
 * claim is "you do not have to trust anyone here", adding a mandatory external dependency to the
 * signing path is the wrong trade, and on a testnet tool it buys very little.
 *
 * There is no server component, no API route, and no backend. Every transaction is built and signed
 * in the browser, which is what lets the confidential path be confidential: the plaintext policy is
 * encrypted here and the ciphertext is all that ever leaves.
 */

// `injected` comes from the wagmi root, NOT from "wagmi/connectors".
//
// That subpath is a barrel: importing anything from it pulls in every connector wagmi ships,
// including baseAccount -> @base-org/account -> @coinbase/cdp-sdk, which imports `@x402/evm` and
// `@x402/svm` as optional peers that are not installed. tsc is happy — it only resolves types —
// and then `next build` fails with "Module not found: Can't resolve '@x402/evm'", pointing at a
// package this application has no interest in.
//
// The wagmi root re-exports `injected` straight from @wagmi/core, so nothing else is dragged along.
import { createConfig, http, injected } from "wagmi";
import { defineChain } from "viem";

import { COSTON2 } from "./contracts";

/**
 * Coston2 as a viem `Chain`.
 *
 * `COSTON2` in contracts.ts is a plain `as const` object shared with the read-only explorer, which
 * needs no wallet. Passing it through `defineChain` gives wagmi the branded type it expects without
 * duplicating the chain id or RPC URL in two places that could drift apart.
 */
export const coston2 = defineChain({
  id: COSTON2.id,
  name: COSTON2.name,
  nativeCurrency: COSTON2.nativeCurrency,
  rpcUrls: COSTON2.rpcUrls,
  blockExplorers: COSTON2.blockExplorers,
  testnet: COSTON2.testnet,
});

export const wagmiConfig = createConfig({
  chains: [coston2],

  // EIP-6963 discovery is what makes the chooser possible: every installed wallet announces itself
  // and becomes its own connector, carrying its real name and icon. Stated explicitly rather than
  // left to the default, because the wallet picker is useless without it.
  multiInjectedProviderDiscovery: true,

  // A generic fallback for wallets too old to announce themselves. When anything *has* announced,
  // this entry is a duplicate under a vaguer name, so components/Wallet.tsx hides it.
  connectors: [injected()],

  transports: { [coston2.id]: http() },
  // The app is a single-page client application; nothing is rendered on a server that would need
  // the connection state hydrated from a cookie.
  ssr: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
