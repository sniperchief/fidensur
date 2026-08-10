/**
 * The allocation policy form.
 *
 * Everything here happens in the browser and stays there. The plaintext policy is never sent
 * anywhere — the page encrypts it and submits only the ciphertext — so this component is the last
 * place a human can check the numbers before they become unreadable to everyone but the enclave.
 *
 * It therefore validates continuously and shows the projected total, using the same rules the Go
 * engine applies. `validatePolicy` is a deliberate mirror of `Validate` in allocate.go: the engine
 * stays the authority, but discovering a typo here costs nothing, whereas discovering it after
 * `requestCompute` costs an on-chain fee and a round trip through a TEE.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { formatEther, type Address } from "viem";

import {
  AllocationMode,
  parseRecipientCsv,
  parseUnits,
  validatePolicy,
  type Policy,
  type PolicyEntry,
  type ValidationResult,
} from "@/lib/policy";

/** What the page needs back: a policy it can seal, or the reasons it cannot. */
export interface PolicyDraftResult {
  entries: PolicyEntry[];
  mode: AllocationMode;
  totalBudget: bigint;
  minAlloc: bigint;
  maxAlloc: bigint;
  bands: bigint[];
  validation: ValidationResult;
  /** Parse failures, which are distinct from policy-rule failures. */
  parseErrors: string[];
}

const MODES: { value: AllocationMode; label: string; help: string; column: string }[] = [
  {
    value: AllocationMode.Explicit,
    label: "Explicit",
    help: "You state each amount directly. The simplest option, and still fully confidential.",
    column: "amount in C2FLR",
  },
  {
    value: AllocationMode.Weighted,
    label: "Weighted",
    help: "The budget is split in proportion to weights. Truncation dust goes to the lowest-indexed recipient.",
    column: "weight (whole number)",
  },
  {
    value: AllocationMode.Tiered,
    label: "Tiered",
    help: "Each recipient names a band. The band table stays secret, so bands are not derivable from the published aggregate.",
    column: "band index (0-based)",
  },
];

const PLACEHOLDER = `# address, value  —  blank lines and # comments are ignored
0x70997970C51812dc3A010C7d01b50e0d17dc79C8, 0.7
0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC, 0.3`;

export function PolicyBuilder({
  contractAddr,
  roundId,
  organization,
  onChange,
}: {
  contractAddr: Address;
  roundId: bigint;
  organization: Address;
  onChange: (result: PolicyDraftResult) => void;
}) {
  const [mode, setMode] = useState<AllocationMode>(AllocationMode.Explicit);
  const [budget, setBudget] = useState("");
  const [minAlloc, setMinAlloc] = useState("");
  const [maxAlloc, setMaxAlloc] = useState("");
  const [bandsText, setBandsText] = useState("");
  const [csv, setCsv] = useState("");

  const active = MODES.find((m) => m.value === mode)!;

  const draft = useMemo<PolicyDraftResult>(() => {
    const parseErrors: string[] = [];

    const amount = (label: string, raw: string): bigint => {
      if (raw.trim() === "") return 0n;
      try {
        return parseUnits(raw, 18);
      } catch (error) {
        parseErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        return 0n;
      }
    };

    const totalBudget = amount("total budget", budget);
    const min = amount("minimum allocation", minAlloc);
    const max = amount("maximum allocation", maxAlloc);

    const bands =
      mode === AllocationMode.Tiered
        ? bandsText
            .split(",")
            .map((b) => b.trim())
            .filter((b) => b !== "")
            .map((b, i) => amount(`band ${i}`, b))
        : [];

    const parsed = parseRecipientCsv(csv, mode, 18);
    parseErrors.push(...parsed.errors);

    const policy: Policy = {
      contractAddr,
      roundId,
      organization,
      mode,
      totalBudget,
      minAlloc: min,
      maxAlloc: max,
      bands,
      // Not the real salt. A fresh one is drawn at seal time, so a policy is never encrypted twice
      // under a salt the user could have seen and reused.
      salt: `0x${"00".repeat(32)}`,
      entries: parsed.entries,
    };

    return {
      entries: parsed.entries,
      mode,
      totalBudget,
      minAlloc: min,
      maxAlloc: max,
      bands,
      validation: validatePolicy(policy),
      parseErrors,
    };
  }, [contractAddr, roundId, organization, mode, budget, minAlloc, maxAlloc, bandsText, csv]);

  useEffect(() => {
    onChange(draft);
    // `onChange` is intentionally excluded: the page passes an inline closure, so including it
    // would re-run this on every render of the parent and loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const problems = [...draft.parseErrors, ...draft.validation.errors];

  return (
    <div className="builder">
      <div className="field-group">
        <label className="label" htmlFor="mode">
          Allocation mode
        </label>
        <div className="mode-row">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`mode-btn${m.value === mode ? " active" : ""}`}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="hint">{active.help}</p>
      </div>

      <div className="field-row">
        <div className="field-group">
          <label className="label" htmlFor="budget">
            Total budget (C2FLR)
          </label>
          <input
            id="budget"
            className="text-input"
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="1.0"
          />
        </div>
        <div className="field-group">
          <label className="label" htmlFor="min">
            Minimum allocation
          </label>
          <input
            id="min"
            className="text-input"
            inputMode="decimal"
            value={minAlloc}
            onChange={(e) => setMinAlloc(e.target.value)}
            placeholder="0 = no floor"
          />
          <p className="hint">Entries computing below this are dropped, not rounded up.</p>
        </div>
        <div className="field-group">
          <label className="label" htmlFor="max">
            Maximum allocation
          </label>
          <input
            id="max"
            className="text-input"
            inputMode="decimal"
            value={maxAlloc}
            onChange={(e) => setMaxAlloc(e.target.value)}
            placeholder="0 = no cap"
          />
        </div>
      </div>

      {mode === AllocationMode.Tiered && (
        <div className="field-group">
          <label className="label" htmlFor="bands">
            Band amounts (C2FLR, comma-separated)
          </label>
          <input
            id="bands"
            className="text-input"
            value={bandsText}
            onChange={(e) => setBandsText(e.target.value)}
            placeholder="1.0, 0.5, 0.25"
          />
          <p className="hint">
            Band 0 is the first value. Recipients reference these by index, and the table itself is
            never published.
          </p>
        </div>
      )}

      <div className="field-group">
        <label className="label" htmlFor="csv">
          Recipients — address, {active.column}
        </label>
        <textarea
          id="csv"
          className="text-input mono"
          rows={10}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={PLACEHOLDER}
          spellCheck={false}
        />
        <p className="hint">
          Amounts are parsed as decimal text, never through floating point — {"parseFloat(\"0.1\")"} ×
          10¹⁸ is not 10¹⁷, and a payroll off by a few wei per person is worse than one that refuses
          to parse.
        </p>
      </div>

      <dl className="facts">
        <div>
          <dt>Recipients</dt>
          <dd>{draft.entries.length}</dd>
        </div>
        <div>
          <dt>Projected total</dt>
          <dd>
            {draft.validation.projectedTotal !== undefined
              ? `${formatEther(draft.validation.projectedTotal)} C2FLR`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Budget</dt>
          <dd>{draft.totalBudget > 0n ? `${formatEther(draft.totalBudget)} C2FLR` : "—"}</dd>
        </div>
      </dl>

      {problems.length > 0 && csv.trim() !== "" && (
        <div className="callout fail">
          <strong>Not ready to encrypt.</strong>
          <ul className="problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {problems.length === 0 && draft.entries.length > 0 && (
        <div className="callout pass">
          <strong>Valid.</strong> The engine applies these same rules, so this should compute without
          rejection.
        </div>
      )}
    </div>
  );
}
