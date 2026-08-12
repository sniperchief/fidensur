/**
 * Hashes, addresses, and copying them.
 *
 * ## Truncation is a display choice, never a data one
 *
 * `CodeHash` shortens a 66-character hash to fit a table cell, but the full value is always in
 * the DOM: as the `title`, and as what the copy button puts on the clipboard. A verification
 * product that shows `0x8f2…a91` and has no way to get at the rest is asking to be trusted about
 * the middle, and the middle is where a substitution would hide.
 *
 * Where the exact value is the point — the report at /verify/[round] — nothing is truncated at
 * all. That page uses plain `<code>`, deliberately, and this component is not used there.
 */

"use client";

import { useEffect, useState } from "react";

import { IconCheck, IconCopy } from "./Icons";

/** `0x8f2c…4a91` — enough to recognise a value without pretending it is the whole thing. */
export function abbreviateHex(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  // Reset on its own timer, cleared on unmount so a copy immediately before navigating away
  // cannot set state on a gone component.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      className="copy-btn"
      data-copied={copied}
      aria-label={copied ? "Copied" : `Copy ${label ?? "value"}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          // Clipboard access is denied outside a secure context and in some embedded browsers.
          // Silently doing nothing is right here: the full value is already selectable text.
        }
      }}
    >
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  );
}

export function CodeHash({
  value,
  lead = 8,
  tail = 6,
  copy = true,
  wrap = false,
  label = "hash",
}: {
  value: string;
  lead?: number;
  tail?: number;
  copy?: boolean;
  /** Show the value in full, wrapped across lines, instead of truncating it. */
  wrap?: boolean;
  label?: string;
}) {
  return (
    <span className={wrap ? "mono-value wrap" : "mono-value"}>
      <span className="mono-text" title={value}>
        {wrap ? value : abbreviateHex(value, lead, tail)}
      </span>
      {copy && <CopyButton value={value} label={label} />}
    </span>
  );
}

export function AddressDisplay({
  address,
  explorer,
  copy = true,
}: {
  address: string;
  /** Block explorer base URL. When given, the address links to it. */
  explorer?: string;
  copy?: boolean;
}) {
  const short = abbreviateHex(address, 6, 4);

  return (
    <span className="mono-value">
      {explorer ? (
        <a
          className="mono-text"
          href={`${explorer}/address/${address}`}
          target="_blank"
          rel="noreferrer"
          title={address}
        >
          {short}
        </a>
      ) : (
        <span className="mono-text" title={address}>
          {short}
        </span>
      )}
      {copy && <CopyButton value={address} label="address" />}
    </span>
  );
}
