/**
 * Client for the FCC extension proxy and the types server.
 *
 * Everything the proxy exposes is public: attestation metadata, and signed results that are already
 * destined for the chain. Nothing here handles a key or a plaintext policy.
 *
 * ## Result polling
 *
 * The FCC documentation says "the caller polls the proxy for the result" without specifying the
 * endpoint or the response shape (`docs/fcc-research.md` §11, item 7). This module previously
 * guessed at three plausible spellings; all three were wrong. The authority is
 * `fccutils.ActionResult` in the Flare scaffold, whose comment marks it "do not modify":
 *
 *     http.Get(nodeURL + "/action/result/" + actionID.Hex())
 *
 * and it decodes `tee-node`'s `types.ActionResponse`:
 *
 *     { "result": { id, submissionTag, status, log, data, … },
 *       "signature": "0x…", "proxySignature": "0x…" }
 *
 * **The signature is a sibling of `result`, not a field inside it.** That is easy to misread and
 * fails in a way that looks like a pending result rather than a parse error.
 */

import type { Address, Hex } from "viem";
import type { ActionResult, AttestationReport } from "./verify";

/** A secp256k1 point as tee-node reports it: two 32-byte hex coordinates, not an encoded key. */
export interface TeePublicKey {
  x: Hex;
  y: Hex;
}

export interface ProxyInfo {
  machineData?: {
    platform?: Hex;
    codeHash?: Hex;
    extensionId?: string | number;
    initialOwner?: Address;
    publicKey?: TeePublicKey;
  };
  [key: string]: unknown;
}

/**
 * Assembles tee-node's `{x, y}` into an uncompressed SEC1 key: `0x04 ‖ X(32) ‖ Y(32)`.
 *
 * `eciesEncrypt` needs the encoded form. Each coordinate is left-padded to a full 32 bytes rather
 * than used as reported — a coordinate with leading zero bytes serializes short, and concatenating
 * the short form silently shifts Y into X's last byte, producing a key that is merely *wrong*
 * rather than invalid. The policy would then encrypt successfully to a point nobody holds.
 */
export function encodeTeePublicKey(key: TeePublicKey): Hex {
  const coord = (v: Hex) => v.slice(2).padStart(64, "0");
  const x = coord(key.x);
  const y = coord(key.y);
  if (x.length !== 64 || y.length !== 64) {
    throw new Error(`TEE public key coordinates are not 32 bytes: x=${key.x} y=${key.y}`);
  }
  return `0x04${x}${y}` as Hex;
}

export class ProxyClient {
  constructor(private readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Reads the proxy's attestation report.
   *
   * This is what tells a verifier whether the enclave is real. Without it the explorer can still
   * check a signature, but cannot say anything about *where* the signing key lives — which is most
   * of the point.
   */
  async info(): Promise<ProxyInfo> {
    const res = await fetch(`${this.baseUrl}/info`, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`proxy /info returned ${res.status}`);
    }
    return (await res.json()) as ProxyInfo;
  }

  /** Extracts the attestation fields, or null when the proxy reports no machine data. */
  async attestation(): Promise<AttestationReport | null> {
    const info = await this.info();
    const m = info.machineData;
    if (!m?.platform || !m?.codeHash) return null;

    return {
      platform: m.platform,
      codeHash: m.codeHash,
      extensionId: String(m.extensionId ?? ""),
      initialOwner: (m.initialOwner ?? "0x0000000000000000000000000000000000000000") as Address,
    };
  }

  /**
   * Reads the enclave's public key, for encrypting a policy to it.
   *
   * This is the key half of the confidential path: get it wrong and the ciphertext is unreadable
   * by the one party meant to read it, discovered only after an on-chain fee has been paid.
   */
  async extensionPublicKey(): Promise<Hex> {
    const info = await this.info();
    const key = info.machineData?.publicKey;
    if (!key?.x || !key?.y) {
      throw new Error("proxy /info reported no machine public key — is the TEE node running?");
    }
    return encodeTeePublicKey(key);
  }

  /**
   * Fetches the signed result for one instruction.
   *
   * Returns null while the result is still pending, so a caller can distinguish "not ready yet"
   * from "failed" — an important difference for COMPUTE, which is asynchronous by design and
   * legitimately reports status 2 for a while.
   */
  async result(instructionId: Hex): Promise<ActionResult | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/action/result/${instructionId}`, { cache: "no-store" });
    } catch {
      return null; // proxy unreachable this tick; the caller's poll loop will retry
    }
    if (!res.ok) return null;

    return normalizeActionResult((await res.json()) as Record<string, unknown>);
  }

  /**
   * Polls until a completed result appears.
   *
   * Status 2 means the handler is still running — for COMPUTE that is the normal path, since the
   * handler acknowledges immediately and finishes on a goroutine. Only status 0 or 1 is terminal.
   */
  async waitForResult(
    instructionId: Hex,
    { timeoutMs = 180_000, intervalMs = 3_000 }: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<ActionResult> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await this.result(instructionId);
      if (result && result.status !== 2) return result;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `no completed result for instruction ${instructionId} within ${timeoutMs}ms. ` +
        `The TEE may be unreachable — the round can be retried after COMPUTE_RETRY_TIMEOUT.`,
    );
  }
}

/**
 * Normalizes a `types.ActionResponse` into an ActionResult.
 *
 * The signature is read from the response root, not from `result` — see the module comment. A
 * status-0 result is returned rather than discarded: it is terminal and its `log` is the only
 * account of what the enclave objected to.
 */
function normalizeActionResult(body: Record<string, unknown>): ActionResult | null {
  const inner = (body.result ?? {}) as Record<string, unknown>;

  const actionId = inner.id as Hex | undefined;
  if (!actionId) return null;

  const data = (inner.data ?? "0x") as Hex;
  const submissionTag = (inner.submissionTag ?? "submit") as string;
  const status = Number(inner.status ?? 2);
  const log = inner.log as string | undefined;
  const signature = (body.signature ?? "0x") as Hex;

  return { data, actionId, submissionTag, status, signature, log };
}

/** Client for the read-only types server, which renders instruction bytes as readable JSON. */
export class TypesServerClient {
  constructor(private readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Decodes a payload.
   *
   * Encrypted payloads come back as shape — `{encrypted, length, hex}` — never as content. That is
   * the types server refusing to decode, not a failure: unwrapping a policy would put confidential
   * data on a public HTTP endpoint.
   */
  async decode(
    opType: string,
    opCommand: string,
    kind: "message" | "result",
    data: Hex,
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/decode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opType, opCommand, kind, data }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `types server returned ${res.status}`);
    }

    const body = (await res.json()) as { decoded: unknown };
    return body.decoded;
  }

  async registry(): Promise<{ engineVersion: string; keys: unknown[] }> {
    const res = await fetch(`${this.baseUrl}/registry`, { cache: "no-store" });
    if (!res.ok) throw new Error(`types server /registry returned ${res.status}`);
    return (await res.json()) as { engineVersion: string; keys: unknown[] };
  }
}
