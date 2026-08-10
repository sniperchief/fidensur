/**
 * Independent, client-side verification of a Fidensur allocation result.
 *
 * This module is the point of the whole product. A verification page that only reports "the
 * contract accepted it" is asking the reader to trust the page. This code re-derives every
 * intermediate value in the browser — result hash, domain-separated payload hash, EIP-191 digest,
 * recovered signer — so a skeptical reader can reproduce each step by hand and compare.
 *
 * It deliberately duplicates `contracts/libraries/TeeResultVerifier.sol` rather than calling it.
 * Two independent implementations agreeing is evidence; one implementation calling itself is not.
 *
 * The scheme, which must stay byte-compatible with `signing.TEEActionResult` in
 * `github.com/flare-foundation/go-flare-common/pkg/signing`:
 *
 *   resultHash  = keccak256(keccak256(resultData) ‖ actionId ‖ keccak256(tag) ‖ status)
 *   payloadHash = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), chainId, resultHash))
 *   digest      = keccak256("\x19Ethereum Signed Message:\n32" ‖ payloadHash)
 *   signature   = ECDSA(digest)
 *
 * Verifying against the bare `resultHash` — omitting the domain wrapper — silently rejects every
 * genuine signature. That is the single easiest thing to get wrong here.
 */

import {
  concatHex,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  recoverAddress,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";

/** Domain-separation prefix, `bytes32("TEE_ACTION_RESULT")` — right-padded with zero bytes. */
export const TEE_ACTION_RESULT_PREFIX = stringToHex("TEE_ACTION_RESULT", { size: 32 });

/** The only ActionResult status a contract may act on. 0 = failed, 1 = ok, ≥2 = still running. */
export const STATUS_SUCCESS = 1;

/** The signed fields of an FCC ActionResult, exactly as the proxy returns them. */
export interface ActionResult {
  /** `ActionResult.Data` — the exact bytes the enclave returned. */
  data: Hex;
  /** `ActionResult.ID` — the FCC instruction id. */
  actionId: Hex;
  /** `ActionResult.SubmissionTag`, typically "submit". */
  submissionTag: string;
  /** `ActionResult.Status`. */
  status: number;
  /** 65-byte `[r ‖ s ‖ v]` signature from the TEE machine. */
  signature: Hex;
  /**
   * `ActionResult.Log` — the enclave's own explanation, populated on failure.
   *
   * Not part of the signed hash, so it is untrusted narration rather than evidence. It is the only
   * account of *why* a status-0 result failed, though, and without it a rejected instruction is
   * indistinguishable from one that never arrived.
   */
  log?: string;
}

/** Every intermediate value, so the UI can show its work rather than assert a conclusion. */
export interface VerificationSteps {
  dataHash: Hex;
  resultHash: Hex;
  payloadHash: Hex;
  eip191Digest: Hex;
  recoveredSigner: Address | null;
  expectedSigner: Address;
  chainId: number;
  statusOk: boolean;
  signerOk: boolean;
  valid: boolean;
  /** Populated when recovery threw — a malformed signature, not a mismatched one. */
  error?: string;
}

/** Step 1: `keccak256(ActionResult.Data)`. */
export function computeDataHash(data: Hex): Hex {
  return keccak256(data);
}

/**
 * Step 2: reconstruct `ActionResult.Hash()`.
 *
 * `encodePacked`, not `encodeAbiParameters` — the node concatenates these fields tightly, so the
 * `uint8` status contributes one byte rather than a padded word.
 */
export function computeResultHash(result: Pick<ActionResult, "data" | "actionId" | "submissionTag" | "status">): Hex {
  return keccak256(
    encodePacked(
      ["bytes32", "bytes32", "bytes32", "uint8"],
      [
        keccak256(result.data),
        result.actionId,
        keccak256(stringToHex(result.submissionTag)),
        result.status,
      ],
    ),
  );
}

/**
 * Step 3: wrap the result hash in the node's domain separation.
 *
 * `encodeAbiParameters` here — padded words, unlike step 2. The asymmetry between the two is real
 * and is a common source of mismatch; it mirrors `abi.encodePacked` vs `abi.encode` in the
 * Solidity verifier.
 *
 * Binding `chainId` is what stops a Coston2 signature being replayed on another chain.
 */
export function computePayloadHash(resultHash: Hex, chainId: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
      [TEE_ACTION_RESULT_PREFIX, BigInt(chainId), resultHash],
    ),
  );
}

/** Step 4: the EIP-191 personal-sign digest that was actually signed. */
export function computeEip191Digest(payloadHash: Hex): Hex {
  return keccak256(concatHex([stringToHex("\x19Ethereum Signed Message:\n32"), payloadHash]));
}

/**
 * Runs every step and reports each one.
 *
 * Returns a full breakdown rather than a boolean on purpose: when verification fails, the reader
 * needs to see *where* — a wrong chain id, a failed status, and a forged signature are three very
 * different findings, and collapsing them into `false` hides the distinction.
 */
export async function verifyActionResult(
  result: ActionResult,
  expectedSigner: Address,
  chainId: number,
): Promise<VerificationSteps> {
  const dataHash = computeDataHash(result.data);
  const resultHash = computeResultHash(result);
  const payloadHash = computePayloadHash(resultHash, chainId);
  const eip191Digest = computeEip191Digest(payloadHash);

  const statusOk = result.status === STATUS_SUCCESS;

  let recoveredSigner: Address | null = null;
  let error: string | undefined;

  try {
    recoveredSigner = await recoverAddress({
      hash: eip191Digest,
      signature: normalizeSignature(result.signature),
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const signerOk =
    recoveredSigner !== null && recoveredSigner.toLowerCase() === expectedSigner.toLowerCase();

  return {
    dataHash,
    resultHash,
    payloadHash,
    eip191Digest,
    recoveredSigner,
    expectedSigner,
    chainId,
    statusOk,
    signerOk,
    valid: statusOk && signerOk,
    error,
  };
}

/**
 * Normalizes the recovery id.
 *
 * `tee-node` emits `v` as 0/1 on some paths and 27/28 on others; viem expects 27/28. The Solidity
 * verifier performs the same normalization, so accepting both here keeps the two implementations
 * agreeing on which signatures are well-formed.
 */
export function normalizeSignature(signature: Hex): Hex {
  const raw = signature.slice(2);
  if (raw.length !== 130) {
    throw new Error(`signature must be 65 bytes, got ${raw.length / 2}`);
  }

  const v = parseInt(raw.slice(128, 130), 16);
  if (v === 27 || v === 28) return signature;
  if (v === 0 || v === 1) {
    return `0x${raw.slice(0, 128)}${(v + 27).toString(16).padStart(2, "0")}` as Hex;
  }
  throw new Error(`invalid signature recovery id: ${v}`);
}

/** The public aggregate carried in `ActionResult.Data`. */
export interface AllocationResult {
  contractAddr: Address;
  roundId: bigint;
  policyCommitment: Hex;
  merkleRoot: Hex;
  totalAllocated: bigint;
  recipientCount: number;
  engineVersion: Hex;
}

/** ABI layout of the allocation result, matching `Fidensur.AllocationResult`. */
export const ALLOCATION_RESULT_ABI = [
  { name: "contractAddr", type: "address" },
  { name: "roundId", type: "uint256" },
  { name: "policyCommitment", type: "bytes32" },
  { name: "merkleRoot", type: "bytes32" },
  { name: "totalAllocated", type: "uint256" },
  { name: "recipientCount", type: "uint32" },
  { name: "engineVersion", type: "bytes32" },
] as const;

/**
 * Checks that a ciphertext matches the commitment recorded on-chain.
 *
 * An organization can publish its policy ciphertext after the fact; this proves the enclave
 * evaluated exactly those bytes. It does not reveal the policy — only the organization can decrypt
 * it, and only the enclave could before that.
 */
export function commitmentMatches(ciphertext: Hex, onChainCommitment: Hex): boolean {
  return keccak256(ciphertext).toLowerCase() === onChainCommitment.toLowerCase();
}

/**
 * Attestation facts read from the extension proxy's `/info` endpoint.
 *
 * A verification page must distinguish a real Confidential Space measurement from a simulated one,
 * or it will look identical in a rehearsal and in production — which would be worse than showing
 * nothing at all.
 */
export interface AttestationReport {
  platform: Hex;
  codeHash: Hex;
  extensionId: string;
  initialOwner: Address;
}

/** `GCP_AMD_SEV` as hex — the prefix a genuine Confidential Space platform value carries. */
export const GCP_AMD_SEV_PREFIX = "0x4743505f414d445f534556";

/** The code hash a simulated TEE reports. Its presence means the attestation is not real. */
export const SIMULATED_CODE_HASH_PREFIX = "0x194844cf";

export interface AttestationVerdict {
  isRealPlatform: boolean;
  isSimulatedCodeHash: boolean;
  matchesRegisteredExtension: boolean;
  /** True only when the platform is real, the code hash is measured, and the extension matches. */
  trustworthy: boolean;
}

export function assessAttestation(
  report: AttestationReport,
  expectedExtensionId: string,
): AttestationVerdict {
  const isRealPlatform = report.platform.toLowerCase().startsWith(GCP_AMD_SEV_PREFIX);
  const isSimulatedCodeHash = report.codeHash.toLowerCase().startsWith(SIMULATED_CODE_HASH_PREFIX);
  const matchesRegisteredExtension = report.extensionId === expectedExtensionId;

  return {
    isRealPlatform,
    isSimulatedCodeHash,
    matchesRegisteredExtension,
    trustworthy: isRealPlatform && !isSimulatedCodeHash && matchesRegisteredExtension,
  };
}

/** Formats a hash for display: `0x1234abcd…ef567890`. */
export function abbreviate(hex: Hex, lead = 10, tail = 8): string {
  if (hex.length <= lead + tail + 2) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

/** Renders a `bytes32`-encoded version string back to text, trimming the zero padding. */
export function decodeVersion(engineVersion: Hex): string {
  const bytes = engineVersion.slice(2).replace(/(00)+$/, "");
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) {
    out += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
  }
  return out;
}

export { toHex };
