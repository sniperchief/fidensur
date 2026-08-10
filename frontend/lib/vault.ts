/**
 * Local persistence for policy ciphertexts.
 *
 * ## Why this exists
 *
 * `requestCompute` accepts only bytes whose keccak256 equals the commitment already recorded
 * on-chain. Re-encrypting the same policy does **not** reproduce them: ECIES draws a fresh ephemeral
 * keypair every time, so a second encryption of identical plaintext is a different ciphertext with a
 * different hash, and the contract rejects it.
 *
 * So the ciphertext is not a cache. It is the only artifact that can advance the round, and the
 * organization is the only party holding it. If it is lost between `submitPolicy` and a successful
 * `finalizeRound`, the round can never be computed — the funds are recoverable via `cancelRound`,
 * but the round itself is dead.
 *
 * That is also why COMPUTE is idempotent in the enclave: resubmitting the same ciphertext after a
 * restart reproduces the same table and the same root. Recovery is always "send those exact bytes
 * again", which requires still having them.
 *
 * ## What this is not
 *
 * Not a backup. localStorage is per-browser, per-origin, and cleared by routine privacy settings.
 * The console offers a file download for the same reason a bank prints a receipt: the durable copy
 * is the one the user holds. This store only spares them re-uploading it during a single sitting.
 *
 * Ciphertexts are not secret — they are ECIES-encrypted to the enclave's public key and are handed
 * to a public chain the moment `requestCompute` is called. Nothing here is confidential, which is
 * why plain localStorage is appropriate.
 */

import type { Hex } from "viem";

const KEY = "fidensur.ciphertexts.v1";

export interface StoredPolicy {
  roundId: string;
  /** `keccak256(ciphertext)` — what the chain committed to. */
  commitment: Hex;
  ciphertext: Hex;
  savedAt: number;
}

type Store = Record<string, StoredPolicy>;

function read(): Store {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    // Corrupt or foreign data under our key. Returning empty degrades to "you must re-upload the
    // file", which is recoverable; throwing here would take down the whole console.
    return {};
  }
}

function write(store: Store): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Quota exceeded, or storage disabled. Not fatal: the download is the real copy, and the
    // console tells the user to keep it.
  }
}

export function savePolicy(entry: Omit<StoredPolicy, "savedAt">): void {
  const store = read();
  store[entry.roundId] = { ...entry, savedAt: Date.now() };
  write(store);
}

export function loadPolicy(roundId: bigint | string): StoredPolicy | null {
  return read()[String(roundId)] ?? null;
}

export function listPolicies(): StoredPolicy[] {
  return Object.values(read()).sort((a, b) => b.savedAt - a.savedAt);
}

export function forgetPolicy(roundId: bigint | string): void {
  const store = read();
  delete store[String(roundId)];
  write(store);
}

/**
 * Triggers a download of the ciphertext as a plain text file.
 *
 * Named for the round and commitment so a directory of these stays sortable and a file can be
 * matched back to its on-chain record without opening it.
 */
export function downloadPolicy(entry: Omit<StoredPolicy, "savedAt">): void {
  const name = `fidensur-round-${entry.roundId}-${entry.commitment.slice(2, 12)}.txt`;
  const body =
    `# Fidensur policy ciphertext\n` +
    `# Round:      ${entry.roundId}\n` +
    `# Commitment: ${entry.commitment}\n` +
    `#\n` +
    `# Keep this file. requestCompute accepts only these exact bytes, and re-encrypting the same\n` +
    `# policy produces different ones. Without it the round cannot be computed or recovered.\n` +
    `${entry.ciphertext}\n`;

  const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Extracts the ciphertext from a downloaded file, ignoring the comment header. */
export function parsePolicyFile(text: string): Hex | null {
  const match = text.match(/0x[0-9a-fA-F]{2,}/);
  return match ? (match[0] as Hex) : null;
}
