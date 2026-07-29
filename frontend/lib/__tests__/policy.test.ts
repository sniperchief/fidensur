/**
 * Policy construction and validation.
 *
 * `validatePolicy` mirrors `Validate` in the Go engine. Duplicated rules are a maintenance cost,
 * accepted because the alternative is an organization discovering a typo only after paying an
 * on-chain fee and waiting for a TEE round trip. These tests pin the mirror to the original.
 *
 * `parseUnits` gets the most attention here because it is the one place a plausible-looking
 * shortcut silently corrupts money.
 */

import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import {
  AllocationMode,
  encodePolicy,
  parseRecipientCsv,
  parseUnits,
  randomSalt,
  validatePolicy,
  type Policy,
} from "../policy";

const CONTRACT = "0x00000000000000000000000000000000000000C0" as Address;
const ORG = "0x00000000000000000000000000000000000000AA" as Address;

const addr = (n: number): Address =>
  `0x${(0x1000 + n).toString(16).padStart(40, "0")}` as Address;

function basePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    contractAddr: CONTRACT,
    roundId: 1n,
    organization: ORG,
    mode: AllocationMode.Explicit,
    totalBudget: 100n * 10n ** 18n,
    minAlloc: 0n,
    maxAlloc: 0n,
    bands: [],
    salt: randomSalt(),
    entries: [],
    ...overrides,
  };
}

describe("parseUnits", () => {
  it("scales whole numbers", () => {
    expect(parseUnits("1", 18)).toBe(10n ** 18n);
    expect(parseUnits("0", 18)).toBe(0n);
    expect(parseUnits("1000000", 18)).toBe(1_000_000n * 10n ** 18n);
  });

  it("scales fractions exactly", () => {
    // The reason this function exists: parseFloat("0.1") * 1e18 is 100000000000000000.0 in theory
    // and not exactly 10^17 in practice. A payroll silently off by a few wei per recipient is
    // worse than one that refuses to parse.
    expect(parseUnits("0.1", 18)).toBe(10n ** 17n);
    expect(parseUnits("0.000000000000000001", 18)).toBe(1n);
    expect(parseUnits("1.5", 18)).toBe(15n * 10n ** 17n);
    expect(parseUnits("123.456", 18)).toBe(123456n * 10n ** 15n);
  });

  it("handles non-18 decimals", () => {
    expect(parseUnits("1.5", 6)).toBe(1_500_000n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
  });

  it("rejects more precision than the token has", () => {
    // Truncating would silently round someone's pay down.
    expect(() => parseUnits("0.0000001", 6)).toThrow(/decimal places/);
  });

  it("rejects anything that is not a plain non-negative decimal", () => {
    for (const bad of ["-1", "1e18", "abc", "", "1.2.3", " ", "0x10"]) {
      expect(() => parseUnits(bad, 18)).toThrow();
    }
  });
});

describe("validatePolicy — explicit mode", () => {
  it("accepts a well-formed policy", () => {
    const result = validatePolicy(
      basePolicy({
        entries: [
          { recipient: addr(1), weight: 0n, amount: 30n * 10n ** 18n },
          { recipient: addr(2), weight: 0n, amount: 20n * 10n ** 18n },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.projectedTotal).toBe(50n * 10n ** 18n);
  });

  it("rejects amounts exceeding the budget", () => {
    const result = validatePolicy(
      basePolicy({
        totalBudget: 10n,
        entries: [
          { recipient: addr(1), weight: 0n, amount: 8n },
          { recipient: addr(2), weight: 0n, amount: 8n },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/budget/);
  });

  it("rejects a populated weight", () => {
    // A weight in explicit mode almost certainly means the author expected it to matter.
    const result = validatePolicy(
      basePolicy({ entries: [{ recipient: addr(1), weight: 5n, amount: 1n }] }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/weight must be zero/);
  });
});

describe("validatePolicy — weighted mode", () => {
  it("accepts positive weights", () => {
    const result = validatePolicy(
      basePolicy({
        mode: AllocationMode.Weighted,
        entries: [
          { recipient: addr(1), weight: 1n, amount: 0n },
          { recipient: addr(2), weight: 3n, amount: 0n },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    // Weighted mode distributes the whole budget, minus dust the engine reassigns.
    expect(result.projectedTotal).toBe(100n * 10n ** 18n);
  });

  it("rejects an all-zero weight set", () => {
    const result = validatePolicy(
      basePolicy({
        mode: AllocationMode.Weighted,
        entries: [{ recipient: addr(1), weight: 0n, amount: 0n }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/positive weight/);
  });

  it("rejects a populated amount", () => {
    const result = validatePolicy(
      basePolicy({
        mode: AllocationMode.Weighted,
        entries: [{ recipient: addr(1), weight: 1n, amount: 5n }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/amount must be zero/);
  });
});

describe("validatePolicy — tiered mode", () => {
  it("accepts in-range band indices", () => {
    const result = validatePolicy(
      basePolicy({
        mode: AllocationMode.Tiered,
        bands: [10n * 10n ** 18n, 25n * 10n ** 18n],
        entries: [
          { recipient: addr(1), weight: 0n, amount: 0n },
          { recipient: addr(2), weight: 1n, amount: 0n },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.projectedTotal).toBe(35n * 10n ** 18n);
  });

  it("rejects a band index past the table", () => {
    const result = validatePolicy(
      basePolicy({
        mode: AllocationMode.Tiered,
        bands: [10n],
        entries: [{ recipient: addr(1), weight: 5n, amount: 0n }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/out of range/);
  });

  it("requires at least one band", () => {
    const result = validatePolicy(
      basePolicy({
        mode: AllocationMode.Tiered,
        bands: [],
        entries: [{ recipient: addr(1), weight: 0n, amount: 0n }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/at least one band/);
  });
});

describe("validatePolicy — shared rules", () => {
  it("rejects duplicate recipients", () => {
    // A duplicate would produce two claimable leaves for one address.
    const result = validatePolicy(
      basePolicy({
        entries: [
          { recipient: addr(1), weight: 0n, amount: 1n },
          { recipient: addr(1), weight: 0n, amount: 2n },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/duplicates recipient/);
  });

  it("treats duplicates case-insensitively", () => {
    // Checksummed and lowercase forms are the same account, and the engine compares raw bytes.
    const lower = addr(1).toLowerCase() as Address;
    const upper = ("0x" + addr(1).slice(2).toUpperCase()) as Address;

    const result = validatePolicy(
      basePolicy({
        entries: [
          { recipient: lower, weight: 0n, amount: 1n },
          { recipient: upper, weight: 0n, amount: 2n },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/duplicates recipient/);
  });

  it("rejects the zero address", () => {
    const result = validatePolicy(
      basePolicy({
        entries: [
          { recipient: "0x0000000000000000000000000000000000000000", weight: 0n, amount: 1n },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/zero address/);
  });

  it("rejects an empty policy", () => {
    expect(validatePolicy(basePolicy()).ok).toBe(false);
  });

  it("rejects a non-positive budget", () => {
    const result = validatePolicy(
      basePolicy({ totalBudget: 0n, entries: [{ recipient: addr(1), weight: 0n, amount: 0n }] }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/budget must be positive/);
  });

  it("rejects a floor above the cap", () => {
    const result = validatePolicy(
      basePolicy({
        minAlloc: 100n,
        maxAlloc: 10n,
        entries: [{ recipient: addr(1), weight: 0n, amount: 5n }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/exceeds maximum/);
  });
});

describe("encodePolicy", () => {
  it("produces deterministic bytes", () => {
    // The commitment is keccak256 of the ciphertext, but the ciphertext is only reproducible if
    // the encoding is. Two encodes of one policy must be identical.
    const policy = basePolicy({
      entries: [{ recipient: addr(1), weight: 0n, amount: 1n }],
    });

    expect(encodePolicy(policy)).toBe(encodePolicy(policy));
  });

  it("changes when any field changes", () => {
    const a = basePolicy({ entries: [{ recipient: addr(1), weight: 0n, amount: 1n }] });
    const b = { ...a, entries: [{ recipient: addr(1), weight: 0n, amount: 2n }] };

    expect(encodePolicy(a)).not.toBe(encodePolicy(b));
  });
});

describe("randomSalt", () => {
  it("returns 32 bytes and does not repeat", () => {
    // The salt is what makes the commitment hiding rather than merely binding: without it, a small
    // known recipient set is an enumerable space and a guess can be confirmed by hashing.
    const salts = new Set(Array.from({ length: 50 }, () => randomSalt()));

    expect(salts.size).toBe(50);
    for (const salt of salts) expect(salt).toHaveLength(66);
  });
});

describe("parseRecipientCsv", () => {
  it("parses explicit amounts and scales them", () => {
    const { entries, errors } = parseRecipientCsv(
      `${addr(1)}, 30\n${addr(2)}, 20.5`,
      AllocationMode.Explicit,
    );

    expect(errors).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.amount).toBe(30n * 10n ** 18n);
    expect(entries[1]?.amount).toBe(205n * 10n ** 17n);
    expect(entries[0]?.weight).toBe(0n);
  });

  it("parses weights without scaling", () => {
    // Weights are ratios, not token amounts — scaling them by 1e18 would be meaningless.
    const { entries } = parseRecipientCsv(`${addr(1)}, 3`, AllocationMode.Weighted);

    expect(entries[0]?.weight).toBe(3n);
    expect(entries[0]?.amount).toBe(0n);
  });

  it("skips blank lines, comments, and a header row", () => {
    const { entries, errors } = parseRecipientCsv(
      `address,amount\n\n# payroll for July\n${addr(1)}, 1\n`,
      AllocationMode.Explicit,
    );

    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  it("reports bad rows with line numbers instead of dropping them", () => {
    const { entries, errors } = parseRecipientCsv(
      `${addr(1)}, 1\nnot-an-address, 2\n${addr(3)}, oops`,
      AllocationMode.Explicit,
    );

    expect(entries).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/line 2/);
    expect(errors[1]).toMatch(/line 3/);
  });
});
