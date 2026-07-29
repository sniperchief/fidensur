/**
 * Checks the browser-side verifier against ground truth from the Solidity implementation.
 *
 * `frontend/lib/verify.ts` reimplements `TeeResultVerifier.sol` rather than calling it, so that a
 * reader who distrusts the contract can still confirm a signature. That argument only holds if the
 * two implementations genuinely agree — which is what this file establishes, step by step, using a
 * vector `test/GenerateSigVectors.t.sol` produced.
 *
 * The step-by-step assertions matter more than the final one. If only the recovered signer were
 * checked, a mismatch would say "verification failed" and nothing about where. Asserting each
 * intermediate hash means a future divergence names its own cause.
 */

import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";

import vector from "./testdata/sig_vector.json";
import {
  TEE_ACTION_RESULT_PREFIX,
  abbreviate,
  assessAttestation,
  commitmentMatches,
  computeDataHash,
  computeEip191Digest,
  computePayloadHash,
  computeResultHash,
  decodeVersion,
  normalizeSignature,
  verifyActionResult,
} from "../verify";

const result = {
  data: vector.data as Hex,
  actionId: vector.actionId as Hex,
  submissionTag: vector.submissionTag,
  status: vector.status,
  signature: vector.signature as Hex,
};

describe("TEE signature scheme, against Solidity ground truth", () => {
  it("step 1: keccak256 of the result data", () => {
    expect(computeDataHash(result.data)).toBe(vector.dataHash);
  });

  it("step 2: ActionResult.Hash()", () => {
    expect(computeResultHash(result)).toBe(vector.resultHash);
  });

  it("step 3: domain-separated payload hash", () => {
    expect(computePayloadHash(vector.resultHash as Hex, vector.chainId)).toBe(vector.payloadHash);
  });

  it("step 4: EIP-191 personal-sign digest", () => {
    expect(computeEip191Digest(vector.payloadHash as Hex)).toBe(vector.eip191Digest);
  });

  it("recovers the signer the Solidity verifier expects", async () => {
    const steps = await verifyActionResult(result, vector.signer as Address, vector.chainId);

    expect(steps.recoveredSigner?.toLowerCase()).toBe(vector.signer.toLowerCase());
    expect(steps.statusOk).toBe(true);
    expect(steps.signerOk).toBe(true);
    expect(steps.valid).toBe(true);
    expect(steps.error).toBeUndefined();
  });

  it("uses the right bytes32 prefix", () => {
    // bytes32("TEE_ACTION_RESULT") — right-padded with zeros, not left-padded, and not hashed.
    expect(TEE_ACTION_RESULT_PREFIX).toBe(
      "0x5445455f414354494f4e5f524553554c5400000000000000000000000000000",
    );
  });
});

describe("rejections", () => {
  it("rejects a signature bound to a different chain", async () => {
    // The chainId inside the signed payload is what stops a Coston2 signature being replayed
    // elsewhere. Verifying under the wrong one must recover a different address.
    const steps = await verifyActionResult(result, vector.signer as Address, vector.chainId + 1);

    expect(steps.signerOk).toBe(false);
    expect(steps.valid).toBe(false);
  });

  it("rejects tampered result data", async () => {
    const tampered = { ...result, data: (result.data.slice(0, -2) + "ff") as Hex };
    const steps = await verifyActionResult(tampered, vector.signer as Address, vector.chainId);

    expect(steps.signerOk).toBe(false);
    expect(steps.valid).toBe(false);
  });

  it("rejects a different submission tag", async () => {
    // The tag is inside the signed hash, so relaying under another one must fail.
    const steps = await verifyActionResult(
      { ...result, submissionTag: "threshold" },
      vector.signer as Address,
      vector.chainId,
    );

    expect(steps.valid).toBe(false);
  });

  it("rejects a non-success status even before checking the signature", async () => {
    // A TEE *failure* must never be relayable as a success.
    const steps = await verifyActionResult(
      { ...result, status: 0 },
      vector.signer as Address,
      vector.chainId,
    );

    expect(steps.statusOk).toBe(false);
    expect(steps.valid).toBe(false);
  });

  it("rejects a pending status", async () => {
    const steps = await verifyActionResult(
      { ...result, status: 2 },
      vector.signer as Address,
      vector.chainId,
    );

    expect(steps.statusOk).toBe(false);
    expect(steps.valid).toBe(false);
  });

  it("reports a malformed signature as an error rather than a mismatch", async () => {
    const steps = await verifyActionResult(
      { ...result, signature: "0xdeadbeef" as Hex },
      vector.signer as Address,
      vector.chainId,
    );

    expect(steps.error).toBeDefined();
    expect(steps.recoveredSigner).toBeNull();
    expect(steps.valid).toBe(false);
  });

  it("rejects a valid signature from an unexpected signer", async () => {
    const steps = await verifyActionResult(
      result,
      "0x000000000000000000000000000000000000dEaD" as Address,
      vector.chainId,
    );

    // Recovery still succeeds — the UI should be able to name the wrong signer, not just say "no".
    expect(steps.recoveredSigner?.toLowerCase()).toBe(vector.signer.toLowerCase());
    expect(steps.signerOk).toBe(false);
    expect(steps.valid).toBe(false);
  });
});

describe("signature normalization", () => {
  it("accepts v = 27/28 unchanged", () => {
    expect(normalizeSignature(result.signature)).toBe(result.signature);
  });

  it("promotes v = 0/1 to 27/28", () => {
    // tee-node emits both forms depending on the path; the Solidity verifier normalizes the same
    // way, so accepting both keeps the two agreeing on what is well-formed.
    const raw = result.signature.slice(2, 130);
    expect(normalizeSignature(`0x${raw}00`)).toBe(`0x${raw}1b`);
    expect(normalizeSignature(`0x${raw}01`)).toBe(`0x${raw}1c`);
  });

  it("rejects a wrong-length signature", () => {
    expect(() => normalizeSignature("0x1234")).toThrow(/65 bytes/);
  });

  it("rejects an invalid recovery id", () => {
    const raw = result.signature.slice(2, 130);
    expect(() => normalizeSignature(`0x${raw}05`)).toThrow(/recovery id/);
  });
});

describe("attestation assessment", () => {
  const realReport = {
    platform: "0x4743505f414d445f53455600000000000000" as Hex,
    codeHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex,
    extensionId: "65536",
    initialOwner: "0x000000000000000000000000000000000000dEaD" as Address,
  };

  it("accepts a real GCP_AMD_SEV measurement", () => {
    const verdict = assessAttestation(realReport, "65536");

    expect(verdict.isRealPlatform).toBe(true);
    expect(verdict.isSimulatedCodeHash).toBe(false);
    expect(verdict.matchesRegisteredExtension).toBe(true);
    expect(verdict.trustworthy).toBe(true);
  });

  it("flags the simulated code hash", () => {
    // A rehearsal must never look identical to production — that would be worse than showing
    // nothing at all.
    const verdict = assessAttestation(
      { ...realReport, codeHash: "0x194844cf0000000000000000000000000000000000000000000000000000" as Hex },
      "65536",
    );

    expect(verdict.isSimulatedCodeHash).toBe(true);
    expect(verdict.trustworthy).toBe(false);
  });

  it("flags a non-SEV platform", () => {
    const verdict = assessAttestation({ ...realReport, platform: "0xdeadbeef" as Hex }, "65536");

    expect(verdict.isRealPlatform).toBe(false);
    expect(verdict.trustworthy).toBe(false);
  });

  it("flags an extension id that does not match registration", () => {
    const verdict = assessAttestation(realReport, "65537");

    expect(verdict.matchesRegisteredExtension).toBe(false);
    expect(verdict.trustworthy).toBe(false);
  });
});

describe("helpers", () => {
  it("matches a ciphertext against its on-chain commitment", () => {
    // Lets an organization publish its ciphertext after the fact and prove the enclave evaluated
    // exactly those bytes — without revealing the policy.
    const ciphertext = "0xdeadbeef" as Hex;
    const commitment = computeDataHash(ciphertext);

    expect(commitmentMatches(ciphertext, commitment)).toBe(true);
    expect(commitmentMatches("0xdeadbeee" as Hex, commitment)).toBe(false);
  });

  it("decodes a bytes32 engine version back to text", () => {
    expect(decodeVersion("0x302e312e30000000000000000000000000000000000000000000000000000000")).toBe(
      "0.1.0",
    );
  });

  it("abbreviates long hashes", () => {
    expect(abbreviate(vector.resultHash as Hex)).toContain("…");
    expect(abbreviate("0x1234" as Hex)).toBe("0x1234");
  });
});
