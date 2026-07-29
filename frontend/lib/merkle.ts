/**
 * Independent Merkle re-derivation, for the verification explorer and the recipient portal.
 *
 * This is the fourth implementation of the same scheme — alongside `AllocationMerkle.sol` (verifies
 * on-chain), `extension/internal/engine/merkle.go` (builds inside the enclave), and
 * `test/helpers/MerkleBuilder.sol` (builds in tests). That is deliberate rather than wasteful: a
 * recipient about to submit a claim should be able to check their proof against the on-chain root
 * *before* spending gas, using code that does not share a bug with the code that produced it.
 *
 * The conventions all four must share:
 *
 *   leaf = keccak256(keccak256(abi.encode(roundId, index, recipient, amount)))
 *
 * The outer hash keeps the leaf domain distinct from the internal-node domain, so a 64-byte
 * internal node cannot be re-presented as leaf preimage data. Internal nodes hash the *sorted*
 * pair, so a proof is a bare sibling list with no direction bits. A level with an odd node count
 * promotes the trailing node unchanged — not duplicated (which would admit a forged proof for a
 * leaf that does not exist) and not paired with a zero hash.
 */

import { concatHex, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/** One row of an allocation table, as a recipient receives it in a disclosure. */
export interface AllocationLeaf {
  roundId: bigint;
  index: bigint;
  recipient: Address;
  amount: bigint;
}

/**
 * Computes the Merkle leaf for one allocation entry.
 *
 * `roundId` is inside the leaf so a proof cannot be replayed against another round that happens to
 * share a root. `recipient` is inside it so a leaked proof is worthless to anyone else — the claim
 * function passes `msg.sender`, never a caller-supplied address.
 */
export function leafHash({ roundId, index, recipient, amount }: AllocationLeaf): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [roundId, index, recipient, amount],
    ),
  );
  return keccak256(inner);
}

/** Commutative pair hash. Ordering the operands is what removes the need for direction bits. */
export function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a]));
}

/**
 * Recomputes a root from a leaf and its proof.
 *
 * A zero root means the round is not finalized. Treat that as unverifiable rather than letting an
 * empty proof against an empty root succeed.
 */
export function verifyProof(root: Hex, leaf: Hex, proof: Hex[]): boolean {
  if (BigInt(root) === 0n) return false;
  return proof.reduce<Hex>((acc, sibling) => hashPair(acc, sibling), leaf) === root;
}

/** Verifies that a recipient is entitled to an amount, against the on-chain root. */
export function verifyAllocation(root: Hex, entry: AllocationLeaf, proof: Hex[]): boolean {
  return verifyProof(root, leafHash(entry), proof);
}

/**
 * Every intermediate hash on the path from leaf to root.
 *
 * The explorer renders these so a reader can follow the derivation step by step instead of taking
 * a boolean on faith. When a proof fails, seeing where it diverges is the difference between a
 * diagnosable problem and a mystery.
 */
export interface ProofTrace {
  leaf: Hex;
  steps: Array<{ current: Hex; sibling: Hex; next: Hex; siblingIsLeft: boolean }>;
  computedRoot: Hex;
  expectedRoot: Hex;
  valid: boolean;
}

export function traceProof(root: Hex, entry: AllocationLeaf, proof: Hex[]): ProofTrace {
  const leaf = leafHash(entry);
  const steps: ProofTrace["steps"] = [];

  let current = leaf;
  for (const sibling of proof) {
    const siblingIsLeft = BigInt(sibling) < BigInt(current);
    const next = hashPair(current, sibling);
    steps.push({ current, sibling, next, siblingIsLeft });
    current = next;
  }

  return {
    leaf,
    steps,
    computedRoot: current,
    expectedRoot: root,
    valid: BigInt(root) !== 0n && current === root,
  };
}

/**
 * Builds a tree over a full allocation table.
 *
 * Only useful to someone holding the whole table — the organization, or an auditor a round has been
 * revealed to. A recipient never has this; they hold one leaf and a proof. Kept here so an
 * organization can confirm, before committing, that its policy will produce the root it expects.
 */
export function buildTree(leaves: Hex[]): { root: Hex; levels: Hex[][] } {
  if (leaves.length === 0) {
    throw new Error("cannot build a Merkle tree over zero leaves");
  }

  const levels: Hex[][] = [[...leaves]];
  let level: Hex[] = [...leaves];

  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      if (left === undefined) break; // unreachable: i < level.length

      const right = level[i + 1];
      // Odd trailing node: promoted unchanged, matching the Go and Solidity implementations.
      // Not duplicated — that would admit a forged proof for a leaf that does not exist.
      next.push(right === undefined ? left : hashPair(left, right));
    }
    levels.push(next);
    level = next;
  }

  const root = level[0];
  if (root === undefined) {
    throw new Error("internal: tree collapsed to an empty level");
  }
  return { root, levels };
}

/** Produces the proof for one leaf of a locally built tree. */
export function buildProof(levels: Hex[][], index: number): Hex[] {
  const proof: Hex[] = [];
  let idx = index;

  for (let depth = 0; depth < levels.length - 1; depth++) {
    const level = levels[depth];
    if (level === undefined) break;

    // A promoted trailing node has no sibling at this level and contributes nothing to the proof.
    const sibling = level[idx ^ 1];
    if (sibling !== undefined) {
      proof.push(sibling);
    }
    idx >>= 1;
  }

  return proof;
}

/** The plaintext a recipient recovers by decrypting a DISCLOSE reply. */
export interface Disclosure {
  roundId: string;
  index: number;
  recipient: Address;
  amount: string;
  proof: Hex[];
  merkleRoot: Hex;
  totalCount: number;
  engineVersion: string;
  computedAt: number;
}

/**
 * Checks a decrypted disclosure against the root the chain actually holds.
 *
 * The enclave reports the root it computed, but a recipient should not have to take that on trust —
 * this compares against the on-chain value and re-derives the proof locally, so a claim is only
 * submitted once it is known to succeed.
 */
export function checkDisclosure(
  disclosure: Disclosure,
  onChainRoot: Hex,
): { rootMatches: boolean; proofValid: boolean; ok: boolean } {
  const rootMatches = disclosure.merkleRoot.toLowerCase() === onChainRoot.toLowerCase();

  const proofValid = verifyAllocation(
    onChainRoot,
    {
      roundId: BigInt(disclosure.roundId),
      index: BigInt(disclosure.index),
      recipient: disclosure.recipient,
      amount: BigInt(disclosure.amount),
    },
    disclosure.proof,
  );

  return { rootMatches, proofValid, ok: rootMatches && proofValid };
}
