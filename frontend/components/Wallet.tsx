/**
 * Wallet connection.
 *
 * ## Why a chooser rather than a button
 *
 * A browser can have several wallets installed at once, and each announces itself under EIP-6963.
 * wagmi surfaces every one as its own connector, so picking the first and connecting to it silently
 * is wrong twice over: it ignores the user's choice, and on a machine with two wallets it will
 * often pick the one they did not mean.
 *
 * So this lists what was actually detected, with each wallet's own name and icon, and connects only
 * to what was chosen.
 *
 * ## Two failure modes that get first-class treatment
 *
 *   - **No wallet at all.** Say so and link somewhere useful; a dead button reads as a broken site.
 *   - **Connected to the wrong chain.** MetaMask stays happily on Ethereum mainnet while the page
 *     talks to Coston2 — every read returns empty and every write reverts, with nothing explaining
 *     why. Offer the switch rather than describing it.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import type { Connector } from "wagmi";

import { coston2 } from "@/lib/wagmi";

/** `0x1234…abcd` — enough to recognise an address without pretending it is the whole thing. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Detected wallets, preferring the ones that announced themselves.
 *
 * The config also registers a generic `injected` connector as a fallback for wallets too old to
 * support EIP-6963. When anything *has* announced itself, that generic entry is a duplicate of one
 * of them under a vaguer name, so it is dropped rather than offered as a mysterious second choice.
 */
function useWalletChoices(): Connector[] {
  const { connectors } = useConnect();

  return useMemo(() => {
    const announced = connectors.filter((c) => c.id !== "injected");
    return announced.length > 0 ? announced : connectors.filter((c) => c.type === "injected");
  }, [connectors]);
}

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [picking, setPicking] = useState(false);

  if (isConnected && chainId !== coston2.id) {
    return (
      <button className="btn btn-warn" onClick={() => switchChain({ chainId: coston2.id })}>
        {switching ? "Switching…" : "Switch to Coston2"}
      </button>
    );
  }

  if (isConnected) {
    return (
      <span className="wallet-account">
        <span className="dot" aria-hidden />
        <code>{shortAddress(address!)}</code>
        <button className="btn btn-ghost btn-sm" onClick={() => disconnect()}>
          Disconnect
        </button>
      </span>
    );
  }

  return (
    <>
      <button className="btn btn-primary" onClick={() => setPicking(true)}>
        Connect wallet
      </button>
      {picking && <WalletPicker onClose={() => setPicking(false)} />}
    </>
  );
}

function WalletPicker({ onClose }: { onClose: () => void }) {
  const { connect, isPending, variables, error } = useConnect();
  const { isConnected } = useAccount();
  const choices = useWalletChoices();

  // Close as soon as a connection lands, rather than leaving the dialog covering the result.
  useEffect(() => {
    if (isConnected) onClose();
  }, [isConnected, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Rendered into `document.body` rather than in place.
  //
  // `.modal-backdrop` is `position: fixed`, which normally resolves against the viewport — but
  // any ancestor with a `transform`, `filter` or `backdrop-filter` becomes the containing block
  // for fixed descendants instead. The workspace topbar and the marketing header both use
  // `backdrop-filter` for their frosted-glass effect, and this button sits inside them, so the
  // dialog was being clipped to a 4rem-tall strip of the header. It opened; you just could not
  // see it.
  //
  // A portal is the fix rather than removing the blur: the dialog should not be at the mercy of
  // whatever styling the thing that triggered it happens to have.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Choose a wallet"
      >
        <div className="modal-head">
          <h2>Connect a wallet</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {choices.length === 0 ? (
          <div className="modal-empty">
            <p>
              <strong>No wallet detected in this browser.</strong>
            </p>
            <p className="hint">
              Fidensur signs everything locally, so it needs a wallet extension — there is no hosted
              account to fall back on.
            </p>
            <a
              className="btn btn-primary"
              href="https://metamask.io/download/"
              target="_blank"
              rel="noreferrer"
            >
              Install MetaMask
            </a>
          </div>
        ) : (
          <ul className="wallet-list">
            {choices.map((connector) => {
              const busy = isPending && variables?.connector === connector;
              return (
                <li key={connector.uid}>
                  <button
                    className="wallet-option"
                    disabled={isPending}
                    onClick={() => connect({ connector })}
                  >
                    {connector.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={connector.icon} alt="" width={28} height={28} />
                    ) : (
                      <span className="wallet-fallback-icon" aria-hidden>
                        {connector.name.slice(0, 1)}
                      </span>
                    )}
                    <span className="wallet-name">{connector.name}</span>
                    <span className="wallet-state">{busy ? "Check your wallet…" : ""}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {error && (
          <p className="modal-error">
            {/* Rejecting a connection request is a choice, not a fault — say so in those terms. */}
            {error.name === "UserRejectedRequestError"
              ? "Connection declined in your wallet."
              : error.message}
          </p>
        )}

        <p className="modal-foot hint">
          Fidensur never sees your keys. Every transaction is built and signed in your browser.
        </p>
      </div>
    </div>,
    document.body,
  );
}

/** Renders children only once a wallet is connected to the right chain. */
export function RequireWallet({ children }: { children: React.ReactNode }) {
  const { isConnected } = useAccount();
  const chainId = useChainId();

  if (!isConnected) {
    return (
      <div className="gate">
        <h2>Connect a wallet to continue</h2>
        <p>
          Everything on this page is built and signed in your browser — there is no backend to send
          it to.
        </p>
        <ConnectButton />
      </div>
    );
  }

  if (chainId !== coston2.id) {
    return (
      <div className="gate">
        <h2>Wrong network</h2>
        <p>
          This deployment lives on Coston2 (chain {coston2.id}). Reads come back empty and writes
          revert until you switch.
        </p>
        <ConnectButton />
      </div>
    );
  }

  return <>{children}</>;
}
