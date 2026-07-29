/**
 * Client for the FCC extension proxy and the types server.
 *
 * Everything the proxy exposes is public: attestation metadata, and signed results that are already
 * destined for the chain. Nothing here handles a key or a plaintext policy.
 *
 * ## A caveat on result polling
 *
 * The FCC documentation says "the caller polls the proxy for the result" without specifying the
 * endpoint, the response shape, or the expected latency (`docs/fcc-research.md` §11, item 7). The
 * implementation below tries the endpoints the reference applications appear to use and normalizes
 * whatever comes back.
 *
 * That guesswork is deliberately confined to this one module. When the real shape is known, this
 * file changes and nothing else does — which is the whole reason the UI never talks to the proxy
 * directly.
 */

import type { Address, Hex } from "viem";
import type { ActionResult, AttestationReport } from "./verify";

export interface ProxyInfo {
  machineData?: {
    platform?: Hex;
    codeHash?: Hex;
    extensionId?: string | number;
    initialOwner?: Address;
  };
  [key: string]: unknown;
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
   * Fetches the signed result for one instruction.
   *
   * Returns null while the result is still pending, so a caller can distinguish "not ready yet"
   * from "failed" — an important difference for COMPUTE, which is asynchronous by design and
   * legitimately reports status 2 for a while.
   */
  async result(instructionId: Hex): Promise<ActionResult | null> {
    // Endpoint naming is not documented; try the plausible candidates in order and take the first
    // that answers. A 404 here means "this proxy spells it differently", not "no such result".
    const candidates = [
      `${this.baseUrl}/result/${instructionId}`,
      `${this.baseUrl}/results/${instructionId}`,
      `${this.baseUrl}/instruction/${instructionId}/result`,
    ];

    for (const url of candidates) {
      let res: Response;
      try {
        res = await fetch(url, { cache: "no-store" });
      } catch {
        continue; // network-level failure on this candidate; try the next
      }
      if (res.status === 404) continue;
      if (!res.ok) continue;

      const body = (await res.json()) as Record<string, unknown>;
      const normalized = normalizeActionResult(body);
      if (normalized) return normalized;
    }

    return null;
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
 * Normalizes a proxy response into an ActionResult.
 *
 * Field naming varies across the FCC surface (`id` vs `actionId`, `submissionTag` vs `tag`), so
 * accept the variants rather than failing on a cosmetic difference. Returns null when the required
 * fields are simply absent — that is a pending result, not a malformed one.
 */
function normalizeActionResult(body: Record<string, unknown>): ActionResult | null {
  const inner = (body.result ?? body.actionResult ?? body) as Record<string, unknown>;

  const data = (inner.data ?? inner.Data) as Hex | undefined;
  const actionId = (inner.id ?? inner.ID ?? inner.actionId) as Hex | undefined;
  const signature = (inner.signature ?? inner.Signature ?? inner.sig) as Hex | undefined;
  const submissionTag = (inner.submissionTag ?? inner.SubmissionTag ?? "submit") as string;
  const status = Number(inner.status ?? inner.Status ?? 2);

  if (!actionId) return null;
  if (status === 2) {
    // Genuinely pending: report it so waitForResult keeps going rather than treating an
    // unsigned in-progress record as a final answer.
    return { data: (data ?? "0x") as Hex, actionId, submissionTag, status, signature: "0x" as Hex };
  }
  if (!data || !signature) return null;

  return { data, actionId, submissionTag, status, signature };
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
