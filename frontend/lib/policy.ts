/**
 * Building and encoding an allocation policy.
 *
 * This is the client half of the confidential path. The organization composes a policy here, in
 * their own browser, and only the ciphertext ever leaves. The plaintext never touches a server,
 * never touches the chain, and is readable only inside the enclave.
 *
 * The ABI layout must match `extension/pkg/types/types.go` exactly. It is decoded inside the TEE
 * with no opportunity to negotiate, so a field-order mistake surfaces as a decode failure in the
 * one place that is hardest to inspect.
 */

import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, type Address, type Hex } from "viem";

import { eciesEncrypt } from "./ecies";

/** Mirrors `types.AllocationMode` in the Go engine. */
export enum AllocationMode {
  /** Amounts given directly. Simplest, and still fully confidential. */
  Explicit = 0,
  /** Split a budget in proportion to weights. */
  Weighted = 1,
  /** Each entry names a band; the band table stays secret. */
  Tiered = 2,
}

export interface PolicyEntry {
  recipient: Address;
  /** Weighted mode: relative share. Tiered mode: band index. Must be 0 in explicit mode. */
  weight: bigint;
  /** Explicit mode: the exact amount. Must be 0 in the other modes. */
  amount: bigint;
}

export interface Policy {
  contractAddr: Address;
  roundId: bigint;
  organization: Address;
  mode: AllocationMode;
  totalBudget: bigint;
  /** Entries computing below this are dropped, not rounded up. Zero disables the floor. */
  minAlloc: bigint;
  /** Caps any single allocation. Zero disables the cap. */
  maxAlloc: bigint;
  /** Per-recipient amount for each tier. Used only by tiered mode. */
  bands: bigint[];
  /** Blinds the commitment. See `randomSalt`. */
  salt: Hex;
  entries: PolicyEntry[];
}

/**
 * ABI layout of `Policy`, matching `types.PolicyArg` in the Go engine.
 *
 * Field order is load-bearing — ABI encoding is positional, so a reordering here produces a
 * ciphertext the enclave decodes into the wrong fields rather than rejecting outright.
 */
export const POLICY_ABI = [
  {
    type: "tuple",
    components: [
      { name: "contractAddr", type: "address" },
      { name: "roundId", type: "uint256" },
      { name: "organization", type: "address" },
      { name: "mode", type: "uint8" },
      { name: "totalBudget", type: "uint256" },
      { name: "minAlloc", type: "uint256" },
      { name: "maxAlloc", type: "uint256" },
      { name: "bands", type: "uint256[]" },
      { name: "salt", type: "bytes32" },
      {
        name: "entries",
        type: "tuple[]",
        components: [
          { name: "recipient", type: "address" },
          { name: "weight", type: "uint256" },
          { name: "amount", type: "uint256" },
        ],
      },
    ],
  },
] as const;

/**
 * Generates a random salt.
 *
 * Without one, the commitment is a hash over a guessable space. An observer who suspects a
 * particular payroll — a known team, plausible round numbers — could enumerate candidate policies
 * and confirm a guess by recomputing the hash. The salt makes the commitment hiding rather than
 * merely binding.
 */
export function randomSalt(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/** ABI-encodes a policy, ready for encryption. */
export function encodePolicy(policy: Policy): Hex {
  return encodeAbiParameters(POLICY_ABI, [
    {
      contractAddr: policy.contractAddr,
      roundId: policy.roundId,
      organization: policy.organization,
      mode: policy.mode,
      totalBudget: policy.totalBudget,
      minAlloc: policy.minAlloc,
      maxAlloc: policy.maxAlloc,
      bands: policy.bands,
      salt: policy.salt,
      entries: policy.entries,
    },
  ]);
}

export interface SealedPolicy {
  /** ECIES ciphertext — the only form that leaves the browser. */
  ciphertext: Hex;
  /** `keccak256(ciphertext)` — recorded on-chain by `submitPolicy`. */
  commitment: Hex;
}

/**
 * Encodes, encrypts, and commits to a policy.
 *
 * **Keep the ciphertext.** The commitment on-chain binds this exact byte string, and
 * `requestCompute` rejects anything else. If the enclave restarts before the round is finalized,
 * recovery is to resubmit the same ciphertext — `COMPUTE` is idempotent and reproduces the same
 * root. Lose it and the round cannot be computed or recovered at all.
 */
export async function sealPolicy(policy: Policy, extensionPubKey: Hex): Promise<SealedPolicy> {
  const validation = validatePolicy(policy);
  if (!validation.ok) {
    // Validate before encrypting. The enclave applies these same rules and would reject the
    // instruction anyway — but only after the organization has paid an on-chain fee and waited
    // for a round trip through the TEE.
    throw new Error(`invalid policy:\n  - ${validation.errors.join("\n  - ")}`);
  }

  const encoded = encodePolicy(policy);
  const ciphertextBytes = await eciesEncrypt(
    hexToBytes(encoded),
    hexToBytes(extensionPubKey),
  );
  const ciphertext = bytesToHex(ciphertextBytes);

  return { ciphertext, commitment: keccak256(ciphertext) };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** What the policy would allocate in total, when that can be determined client-side. */
  projectedTotal?: bigint;
}

/**
 * Checks a policy against the same rules the engine enforces.
 *
 * Deliberately a mirror of `Validate` in `extension/internal/engine/allocate.go`. Duplicated logic
 * is a maintenance cost, but the alternative is discovering a typo after an on-chain fee and a TEE
 * round trip. The engine remains the authority; this is a fast local preview of its verdict.
 */
export function validatePolicy(policy: Policy): ValidationResult {
  const errors: string[] = [];

  if (policy.totalBudget <= 0n) errors.push("total budget must be positive");
  if (policy.minAlloc < 0n) errors.push("minimum allocation must not be negative");
  if (policy.maxAlloc < 0n) errors.push("maximum allocation must not be negative");
  if (policy.maxAlloc > 0n && policy.minAlloc > policy.maxAlloc) {
    errors.push("minimum allocation exceeds maximum allocation");
  }
  if (policy.entries.length === 0) errors.push("policy has no recipients");
  if (policy.entries.length > 4096) {
    errors.push(`policy has ${policy.entries.length} recipients, limit is 4096`);
  }

  // A duplicate would produce two claimable leaves for one address. The engine rejects rather than
  // merging, because merging would silently rewrite the organization's intent.
  const seen = new Map<string, number>();
  policy.entries.forEach((entry, i) => {
    const key = entry.recipient.toLowerCase();
    if (entry.recipient === "0x0000000000000000000000000000000000000000") {
      errors.push(`entry ${i}: recipient is the zero address`);
    }
    const prev = seen.get(key);
    if (prev !== undefined) {
      errors.push(`entry ${i} duplicates recipient from entry ${prev}`);
    }
    seen.set(key, i);
    if (entry.weight < 0n) errors.push(`entry ${i}: weight must not be negative`);
    if (entry.amount < 0n) errors.push(`entry ${i}: amount must not be negative`);
  });

  let projectedTotal: bigint | undefined;

  switch (policy.mode) {
    case AllocationMode.Explicit: {
      if (policy.bands.length > 0) errors.push("bands must be empty in explicit mode");
      let total = 0n;
      policy.entries.forEach((entry, i) => {
        // Stricter than strictly necessary, on purpose: a populated weight in explicit mode almost
        // certainly means the author expected it to be honoured.
        if (entry.weight !== 0n) errors.push(`entry ${i}: weight must be zero in explicit mode`);
        total += entry.amount;
      });
      if (total > policy.totalBudget) {
        errors.push(`amounts total ${total} but the budget is ${policy.totalBudget}`);
      }
      projectedTotal = total;
      break;
    }

    case AllocationMode.Weighted: {
      if (policy.bands.length > 0) errors.push("bands must be empty in weighted mode");
      let weightSum = 0n;
      policy.entries.forEach((entry, i) => {
        if (entry.amount !== 0n) errors.push(`entry ${i}: amount must be zero in weighted mode`);
        weightSum += entry.weight;
      });
      if (weightSum === 0n) errors.push("weighted mode needs at least one positive weight");
      // The whole budget is distributed, minus truncation dust the engine reassigns.
      projectedTotal = weightSum > 0n ? policy.totalBudget : 0n;
      break;
    }

    case AllocationMode.Tiered: {
      if (policy.bands.length === 0) errors.push("tiered mode needs at least one band");
      policy.bands.forEach((band, i) => {
        if (band < 0n) errors.push(`band ${i}: amount must not be negative`);
      });
      let total = 0n;
      policy.entries.forEach((entry, i) => {
        if (entry.amount !== 0n) errors.push(`entry ${i}: amount must be zero in tiered mode`);
        if (entry.weight >= BigInt(policy.bands.length)) {
          errors.push(`entry ${i}: band index ${entry.weight} is out of range`);
        } else {
          total += policy.bands[Number(entry.weight)] ?? 0n;
        }
      });
      if (total > policy.totalBudget) {
        errors.push(`band amounts total ${total} but the budget is ${policy.totalBudget}`);
      }
      projectedTotal = total;
      break;
    }

    default:
      errors.push(`unknown allocation mode ${policy.mode}`);
  }

  return { ok: errors.length === 0, errors, projectedTotal };
}

/**
 * Parses a CSV recipient list.
 *
 * Two columns: address, then amount (explicit mode) or weight (weighted and tiered). Blank lines
 * and `#` comments are skipped, and a header row is detected and dropped.
 *
 * Amounts are parsed as **whole token units** and scaled by `decimals`, using string manipulation
 * rather than floating point — `parseFloat("0.1") * 1e18` does not produce 10^17, and a payroll
 * that is silently off by a few wei per recipient is worse than one that refuses to parse.
 */
export function parseRecipientCsv(
  csv: string,
  mode: AllocationMode,
  decimals = 18,
): { entries: PolicyEntry[]; errors: string[] } {
  const entries: PolicyEntry[] = [];
  const errors: string[] = [];

  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  lines.forEach((line, index) => {
    const parts = line.split(",").map((p) => p.trim());
    const [addressRaw, valueRaw] = parts;

    if (!addressRaw || !valueRaw) {
      errors.push(`line ${index + 1}: expected "address, value"`);
      return;
    }
    // Header row, e.g. "address,amount".
    if (index === 0 && !/^0x[0-9a-fA-F]{40}$/.test(addressRaw)) return;

    if (!/^0x[0-9a-fA-F]{40}$/.test(addressRaw)) {
      errors.push(`line ${index + 1}: "${addressRaw}" is not an address`);
      return;
    }

    let value: bigint;
    try {
      value = mode === AllocationMode.Explicit ? parseUnits(valueRaw, decimals) : BigInt(valueRaw);
    } catch {
      errors.push(`line ${index + 1}: "${valueRaw}" is not a valid number`);
      return;
    }

    entries.push(
      mode === AllocationMode.Explicit
        ? { recipient: addressRaw as Address, weight: 0n, amount: value }
        : { recipient: addressRaw as Address, weight: value, amount: 0n },
    );
  });

  return { entries, errors };
}

/**
 * Converts a decimal string to base units without floating point.
 *
 * `parseFloat("0.1") * 1e18` is not 10^17. For money that is unacceptable, so the fractional part
 * is padded and concatenated as text instead.
 */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`"${value}" is not a non-negative decimal number`);
  }

  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new Error(`"${value}" has more than ${decimals} decimal places`);
  }

  return BigInt(whole + fraction.padEnd(decimals, "0"));
}
