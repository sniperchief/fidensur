/**
 * Wallet connection, and the guard the write pages sit behind.
 *
 * Two failure modes get first-class treatment rather than a disabled button, because both are
 * common and both are invisible otherwise:
 *
 *   - **No injected wallet.** Say so, and link somewhere useful. A greyed-out "Connect" with no
 *     explanation reads as a broken site.
 *   - **Connected to the wrong chain.** MetaMask happily stays on Ethereum mainnet while the page
 *     talks to Coston2. Every read returns nothing and every write reverts, with no obvious cause.
 *     Offer the switch rather than describing it.
 */

"use client";

import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { coston2 } from "@/lib/wagmi";

/** `0x1234…abcd` — enough to recognise an address without pretending it is the whole thing. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const injected = connectors.find((c) => c.type === "injected") ?? connectors[0];

  if (!isConnected) {
    if (!injected) {
      return (
        <a className="wallet-link" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
          Install a wallet
        </a>
      );
    }
    return (
      <button className="wallet-btn" onClick={() => connect({ connector: injected })} disabled={isPending}>
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  if (chainId !== coston2.id) {
    return (
      <button className="wallet-btn warn" onClick={() => switchChain({ chainId: coston2.id })}>
        Switch to Coston2
      </button>
    );
  }

  return (
    <span className="wallet-account">
      <code>{shortAddress(address!)}</code>
      <button className="wallet-btn ghost" onClick={() => disconnect()}>
        Disconnect
      </button>
    </span>
  );
}

/**
 * Renders children only once a wallet is connected to the right chain.
 *
 * Wrapping a write page in this is what stops it rendering a form that cannot possibly submit.
 */
export function RequireWallet({ children }: { children: React.ReactNode }) {
  const { isConnected } = useAccount();
  const chainId = useChainId();

  if (!isConnected) {
    return (
      <div className="callout unknown">
        <strong>Connect a wallet to continue.</strong> Everything on this page is built and signed in
        your browser — there is no backend to send it to.
        <div style={{ marginTop: "0.75rem" }}>
          <ConnectButton />
        </div>
      </div>
    );
  }

  if (chainId !== coston2.id) {
    return (
      <div className="callout warn">
        <strong>Wrong network.</strong> This deployment lives on Coston2 (chain {coston2.id}). Reads
        will come back empty and writes will revert until you switch.
        <div style={{ marginTop: "0.75rem" }}>
          <ConnectButton />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
