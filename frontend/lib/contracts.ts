/**
 * Typed contract surface and chain configuration.
 *
 * Only the functions the frontend actually calls are declared. A trimmed ABI keeps the bundle
 * small and, more usefully, makes it obvious at a glance what the UI is capable of doing on-chain —
 * a reader can confirm the explorer is read-only by seeing that it imports no write functions.
 */

import type { Address, Hex } from "viem";

/** Coston2 — the Flare testnet FCC is deployed on. */
export const COSTON2 = {
  id: 114,
  name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: ["https://coston2-api.flare.network/ext/C/rpc"] } },
  blockExplorers: { default: { name: "Coston2 Explorer", url: "https://coston2-explorer.flare.network" } },
  testnet: true,
} as const;

/** Round lifecycle, mirroring `Fidensur.RoundStatus`. Order must match the Solidity enum. */
export const ROUND_STATUS = [
  "None",
  "Open",
  "Committed",
  "Computing",
  "Finalized",
  "Closed",
  "Cancelled",
] as const;

export type RoundStatus = (typeof ROUND_STATUS)[number];

/**
 * A round as viem decodes it.
 *
 * Note the integer widths: viem returns `number` for Solidity integers up to 48 bits and `bigint`
 * above that, because everything through uint48 fits in a JS number without precision loss. So the
 * three `uint48` timestamps arrive as `number` while the `uint256` amounts arrive as `bigint`.
 * Declaring the timestamps as `bigint` type-checks against the ABI and then fails at runtime on the
 * first arithmetic — worth getting right here rather than discovering downstream.
 */
export interface Round {
  organization: Address;
  status: number;
  swept: boolean;
  recipientCount: number;
  /** uint48 — seconds. */
  claimWindow: number;
  token: Address;
  /** uint48 — unix seconds. */
  claimDeadline: number;
  /** uint48 — unix seconds. */
  computeRequestedAt: number;
  funded: bigint;
  totalAllocated: bigint;
  totalClaimed: bigint;
  policyCommitment: Hex;
  merkleRoot: Hex;
  computeInstructionId: Hex;
  engineVersion: Hex;
}

/**
 * Every custom error the contract can revert with.
 *
 * These must be in the ABI passed to any call, or viem cannot decode a revert and surfaces the raw
 * four-byte selector instead — "reverted with signature 0x6a4fd69d", which tells a user nothing.
 * The contract uses custom errors throughout (they are far cheaper than revert strings), so without
 * these every failure is unreadable.
 *
 * Kept as a separate constant and spread into each ABI below, so adding an error means adding it
 * once rather than in three places.
 */
export const FIDENSUR_ERRORS_ABI = [
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "NoCode", inputs: [{ name: "target", type: "address" }] },
  { type: "error", name: "ExtensionIdAlreadySet", inputs: [] },
  { type: "error", name: "ExtensionIdNotFound", inputs: [] },
  { type: "error", name: "ExtensionIdNotSet", inputs: [] },
  { type: "error", name: "TeeAddressNotSet", inputs: [] },
  { type: "error", name: "NoSuchRound", inputs: [{ name: "roundId", type: "uint256" }] },
  {
    type: "error",
    name: "WrongStatus",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "actual", type: "uint8" },
      { name: "expected", type: "uint8" },
    ],
  },
  {
    type: "error",
    name: "NotOrganization",
    inputs: [
      { name: "caller", type: "address" },
      { name: "organization", type: "address" },
    ],
  },
  { type: "error", name: "InvalidClaimWindow", inputs: [{ name: "provided", type: "uint48" }] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "NothingFunded", inputs: [{ name: "roundId", type: "uint256" }] },
  { type: "error", name: "EmptyCommitment", inputs: [] },
  {
    type: "error",
    name: "CiphertextMismatch",
    inputs: [
      { name: "provided", type: "bytes32" },
      { name: "committed", type: "bytes32" },
    ],
  },
  { type: "error", name: "EmptyCiphertext", inputs: [] },
  {
    type: "error",
    name: "RetryTooSoon",
    inputs: [
      { name: "requestedAt", type: "uint48" },
      { name: "earliestRetry", type: "uint48" },
    ],
  },
  { type: "error", name: "NoTeeAvailable", inputs: [] },
  { type: "error", name: "ResultNotForThisContract", inputs: [{ name: "encoded", type: "address" }] },
  {
    type: "error",
    name: "ResultNotForThisRound",
    inputs: [
      { name: "actionId", type: "bytes32" },
      { name: "expected", type: "bytes32" },
    ],
  },
  {
    type: "error",
    name: "PolicyCommitmentMismatch",
    inputs: [
      { name: "encoded", type: "bytes32" },
      { name: "stored", type: "bytes32" },
    ],
  },
  { type: "error", name: "EmptyMerkleRoot", inputs: [] },
  { type: "error", name: "NoRecipients", inputs: [] },
  {
    type: "error",
    name: "OverAllocated",
    inputs: [
      { name: "totalAllocated", type: "uint256" },
      { name: "funded", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "AlreadyClaimed",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "index", type: "uint256" },
    ],
  },
  { type: "error", name: "ClaimWindowClosed", inputs: [{ name: "deadline", type: "uint48" }] },
  { type: "error", name: "ClaimWindowStillOpen", inputs: [{ name: "deadline", type: "uint48" }] },
  { type: "error", name: "BadMerkleProof", inputs: [] },
  { type: "error", name: "AlreadySwept", inputs: [{ name: "roundId", type: "uint256" }] },
  { type: "error", name: "InvalidDisclosureKey", inputs: [{ name: "length", type: "uint256" }] },
  { type: "error", name: "NothingToRescue", inputs: [] },
] as const;

/**
 * The read surface the verification explorer uses.
 *
 * Everything here is a `view`. The explorer never sends a transaction — a page whose job is to let
 * a reader check someone else's claims should not also be able to change state.
 */
export const FIDENSUR_READ_ABI = [
  ...FIDENSUR_ERRORS_ABI,
  {
    type: "function",
    name: "getRound",
    stateMutability: "view",
    inputs: [{ name: "_roundId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "organization", type: "address" },
          { name: "status", type: "uint8" },
          { name: "swept", type: "bool" },
          { name: "recipientCount", type: "uint32" },
          { name: "claimWindow", type: "uint48" },
          { name: "token", type: "address" },
          { name: "claimDeadline", type: "uint48" },
          { name: "computeRequestedAt", type: "uint48" },
          { name: "funded", type: "uint256" },
          { name: "totalAllocated", type: "uint256" },
          { name: "totalClaimed", type: "uint256" },
          { name: "policyCommitment", type: "bytes32" },
          { name: "merkleRoot", type: "bytes32" },
          { name: "computeInstructionId", type: "bytes32" },
          { name: "engineVersion", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "teeAddress",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "extensionId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "nextRoundId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "isClaimed",
    stateMutability: "view",
    inputs: [
      { name: "_roundId", type: "uint256" },
      { name: "_index", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    // Lets the explorer re-derive a leaf through the same code path the claim check uses, rather
    // than a JavaScript reimplementation that could drift from it.
    type: "function",
    name: "allocationLeaf",
    stateMutability: "pure",
    inputs: [
      { name: "_roundId", type: "uint256" },
      { name: "_index", type: "uint256" },
      { name: "_recipient", type: "address" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    // A second opinion on signature validity, from the contract itself. The explorer also recovers
    // the signer client-side; showing both is the point.
    type: "function",
    name: "checkTeeResult",
    stateMutability: "view",
    inputs: [
      { name: "_resultData", type: "bytes" },
      { name: "_actionId", type: "bytes32" },
      { name: "_submissionTag", type: "string" },
      { name: "_status", type: "uint8" },
      { name: "_signature", type: "bytes" },
    ],
    outputs: [
      { name: "valid", type: "bool" },
      { name: "recoveredSigner", type: "address" },
    ],
  },
] as const;

/** Write functions, used by the organization console and the recipient portal only. */
export const FIDENSUR_WRITE_ABI = [
  ...FIDENSUR_ERRORS_ABI,
  {
    type: "function",
    name: "createRound",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_token", type: "address" },
      { name: "_claimWindow", type: "uint48" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "payable",
    inputs: [
      { name: "_roundId", type: "uint256" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "submitPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_roundId", type: "uint256" },
      { name: "_policyCommitment", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "requestCompute",
    stateMutability: "payable",
    inputs: [
      { name: "_roundId", type: "uint256" },
      { name: "_ciphertext", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeRound",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_resultData", type: "bytes" },
      { name: "_actionId", type: "bytes32" },
      { name: "_submissionTag", type: "string" },
      { name: "_status", type: "uint8" },
      { name: "_signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "requestDisclosure",
    stateMutability: "payable",
    inputs: [
      { name: "_roundId", type: "uint256" },
      { name: "_disclosureKey", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_roundId", type: "uint256" },
      { name: "_index", type: "uint256" },
      { name: "_amount", type: "uint256" },
      { name: "_proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
] as const;

/** Events the explorer replays to build a round's timeline. */
export const FIDENSUR_EVENTS_ABI = [
  {
    type: "event",
    name: "RoundCreated",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "organization", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "claimWindow", type: "uint48", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PolicyCommitted",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "policyCommitment", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "ComputeRequested",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "instructionId", type: "bytes32", indexed: true },
      { name: "teeIds", type: "address[]", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RoundFinalized",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "merkleRoot", type: "bytes32", indexed: true },
      { name: "totalAllocated", type: "uint256", indexed: false },
      { name: "recipientCount", type: "uint32", indexed: false },
      { name: "engineVersion", type: "bytes32", indexed: false },
      { name: "actionId", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AllocationClaimed",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "index", type: "uint256", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Native C2FLR is represented as the zero address throughout the contract. */
export const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

export function statusName(status: number): RoundStatus {
  return ROUND_STATUS[status] ?? "None";
}

/** Formats a token amount for display without pulling in a formatting dependency. */
export function formatAmount(value: bigint, decimals = 18, precision = 4): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  if (frac === 0n) return whole.toString();

  const fracStr = frac.toString().padStart(decimals, "0").slice(0, precision).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}
