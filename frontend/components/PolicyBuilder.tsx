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
 *
 * ## Rows, not a textarea
 *
 * Recipients used to be a CSV textarea — type an address, a comma, an amount, one per line. That
 * asks a person to be a parser: a missing comma, a stray space, or a pasted address with a
 * trailing newline all become "line 4: expected address, value" *after* they have typed
 * everything. Two fields per row cannot be mis-delimited, the value column can be labelled for
 * the current mode, and a bad address is flagged on the row that has it rather than in a list of
 * line numbers underneath.
 *
 * The textarea survives as an explicit bulk-paste affordance, because a payroll of two hundred
 * people is a genuinely different task from adding three. It appends rows and then gets out of
 * the way — it is not the state of the form.
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatEther, type Address } from "viem";

import { IconClose, IconPlus, IconUsers } from "@/components/ui/Icons";
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

interface Row {
  id: number;
  address: string;
  value: string;
}

const MODES: { value: AllocationMode; label: string; help: string; column: string; placeholder: string }[] = [
  {
    value: AllocationMode.Explicit,
    label: "Explicit",
    help: "You state each amount directly. The simplest option, and still fully confidential.",
    column: "Amount (C2FLR)",
    placeholder: "0.5",
  },
  {
    value: AllocationMode.Weighted,
    label: "Weighted",
    help: "The budget is split in proportion to weights. Truncation dust goes to the lowest-indexed recipient.",
    column: "Weight",
    placeholder: "3",
  },
  {
    value: AllocationMode.Tiered,
    label: "Tiered",
    help: "Each recipient names a band. The band table stays secret, so bands are not derivable from the published aggregate.",
    column: "Band",
    placeholder: "0",
  },
];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

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
  const [rows, setRows] = useState<Row[]>([{ id: 1, address: "", value: "" }]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkProblem, setBulkProblem] = useState<string | null>(null);

  // A counter rather than randomUUID: ids only need to be stable across re-renders so React can
  // keep an input's focus and cursor position when a row above it is removed.
  const nextId = useRef(2);
  const lastAddressRef = useRef<HTMLInputElement>(null);
  const focusLast = useRef(false);

  const active = MODES.find((m) => m.value === mode)!;

  const addRow = () => {
    focusLast.current = true;
    setRows((prev) => [...prev, { id: nextId.current++, address: "", value: "" }]);
  };

  // Focus the address field of a freshly added row, so "+" then typing works without a click.
  useEffect(() => {
    if (focusLast.current) {
      lastAddressRef.current?.focus();
      focusLast.current = false;
    }
  }, [rows]);

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

    const totalBudget = amount("Total budget", budget);
    const min = amount("Minimum allocation", minAlloc);
    const max = amount("Maximum allocation", maxAlloc);

    const bands =
      mode === AllocationMode.Tiered
        ? bandsText
            .split(",")
            .map((b) => b.trim())
            .filter((b) => b !== "")
            .map((b, i) => amount(`Band ${i}`, b))
        : [];

    const entries: PolicyEntry[] = [];
    const seen = new Map<string, number>();

    rows.forEach((row, index) => {
      const address = row.address.trim();
      const value = row.value.trim();

      // A row nobody has touched is not an error, it is an empty row.
      if (address === "" && value === "") return;

      const position = `Recipient ${index + 1}`;

      if (!ADDRESS_RE.test(address)) {
        parseErrors.push(
          address === ""
            ? `${position}: enter a wallet address`
            : `${position}: "${address}" is not a valid address`,
        );
        return;
      }

      const key = address.toLowerCase();
      const duplicate = seen.get(key);
      if (duplicate !== undefined) {
        parseErrors.push(`${position}: this address is already recipient ${duplicate + 1}`);
        return;
      }
      seen.set(key, index);

      if (value === "") {
        parseErrors.push(`${position}: enter ${active.column.toLowerCase()}`);
        return;
      }

      try {
        const parsed =
          mode === AllocationMode.Explicit ? parseUnits(value, 18) : BigInt(value);
        entries.push({
          recipient: address as Address,
          amount: mode === AllocationMode.Explicit ? parsed : 0n,
          weight: mode === AllocationMode.Explicit ? 0n : parsed,
        });
      } catch {
        parseErrors.push(`${position}: "${value}" is not a valid ${active.column.toLowerCase()}`);
      }
    });

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
      entries,
    };

    return {
      entries,
      mode,
      totalBudget,
      minAlloc: min,
      maxAlloc: max,
      bands,
      validation: validatePolicy(policy),
      parseErrors,
    };
  }, [contractAddr, roundId, organization, mode, budget, minAlloc, maxAlloc, bandsText, rows, active.column]);

  useEffect(() => {
    onChange(draft);
    // `onChange` is intentionally excluded: the page passes an inline closure, so including it
    // would re-run this on every render of the parent and loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  /** Per-row validity, for the red outline. Untouched rows are not "invalid", just empty. */
  const rowState = (row: Row, index: number): "ok" | "bad" | "empty" => {
    const address = row.address.trim();
    if (address === "" && row.value.trim() === "") return "empty";
    if (!ADDRESS_RE.test(address)) return "bad";
    const firstUse = rows.findIndex((r) => r.address.trim().toLowerCase() === address.toLowerCase());
    if (firstUse !== index) return "bad";
    return "ok";
  };

  const importBulk = () => {
    const parsed = parseRecipientCsv(bulkText, mode, 18);
    if (parsed.errors.length > 0) {
      setBulkProblem(parsed.errors.slice(0, 3).join(" · "));
      return;
    }
    if (parsed.entries.length === 0) {
      setBulkProblem("Nothing to import — expected one `address, value` per line.");
      return;
    }

    setRows((prev) => {
      // Drop rows that were left blank, so importing into a fresh form does not leave a stray
      // empty row at the top.
      const kept = prev.filter((r) => r.address.trim() !== "" || r.value.trim() !== "");
      const added = parsed.entries.map((entry) => ({
        id: nextId.current++,
        address: entry.recipient,
        value:
          mode === AllocationMode.Explicit
            ? formatEther(entry.amount)
            : entry.weight.toString(),
      }));
      return [...kept, ...added];
    });

    setBulkText("");
    setBulkProblem(null);
    setBulkOpen(false);
  };

  const problems = [...draft.parseErrors, ...draft.validation.errors];
  const filled = rows.filter((r) => r.address.trim() !== "" || r.value.trim() !== "").length;

  return (
    <div className="builder">
      <div className="field-group">
        <span className="field-label">Allocation mode</span>
        <div className="segmented" role="group" aria-label="Allocation mode">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              aria-pressed={m.value === mode}
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
          <label className="field-label" htmlFor="budget">
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
          <label className="field-label" htmlFor="min">
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
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="max">
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
          <label className="field-label" htmlFor="bands">
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

      {/* ---------------- recipients ---------------- */}

      <div className="recipients">
        <div className="recipients-head">
          <span className="field-label" style={{ margin: 0 }}>
            Recipients
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBulkOpen((v) => !v)}>
            {bulkOpen ? "Cancel paste" : "Paste a list"}
          </button>
        </div>

        {bulkOpen && (
          <div className="bulk-paste">
            <label className="field-label" htmlFor="bulk">
              One <code>address, {active.column.toLowerCase()}</code> per line
            </label>
            <textarea
              id="bulk"
              className="text-input mono"
              rows={5}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              spellCheck={false}
              placeholder={`0x70997970C51812dc3A010C7d01b50e0d17dc79C8, ${active.placeholder}`}
            />
            {bulkProblem && <p className="row-error">{bulkProblem}</p>}
            <div className="btn-group" style={{ marginTop: "var(--s3)" }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={importBulk}>
                Add to list
              </button>
            </div>
          </div>
        )}

        {filled === 0 && rows.length <= 1 ? (
          <div className="recipients-empty">
            <span className="empty-mark" aria-hidden="true">
              <IconUsers size={18} />
            </span>
            <p>No recipients yet. Add the first one to start building the allocation.</p>
          </div>
        ) : (
          <ul className="recipient-rows">
            {rows.map((row, index) => {
              const state = rowState(row, index);
              const isLast = index === rows.length - 1;
              return (
                <li className="recipient-row" data-state={state} key={row.id}>
                  <span className="recipient-index" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>

                  <input
                    ref={isLast ? lastAddressRef : undefined}
                    className="text-input mono"
                    value={row.address}
                    spellCheck={false}
                    placeholder="0x…"
                    aria-label={`Recipient ${index + 1} address`}
                    aria-invalid={state === "bad"}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) => (r.id === row.id ? { ...r, address: e.target.value.trim() } : r)),
                      )
                    }
                  />

                  <input
                    className="text-input recipient-value"
                    inputMode="decimal"
                    value={row.value}
                    placeholder={active.placeholder}
                    aria-label={`Recipient ${index + 1} ${active.column.toLowerCase()}`}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)),
                      )
                    }
                    onKeyDown={(e) => {
                      // Enter at the end of the last row adds another, so a list can be entered
                      // without reaching for the mouse.
                      if (e.key === "Enter" && isLast) {
                        e.preventDefault();
                        addRow();
                      }
                    }}
                  />

                  <button
                    type="button"
                    className="row-remove"
                    aria-label={`Remove recipient ${index + 1}`}
                    disabled={rows.length === 1}
                    onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                  >
                    <IconClose size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="recipients-foot">
          <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>
            <IconPlus size={14} />
            Add recipient
          </button>

          <span className="recipients-tally">
            {draft.entries.length} recipient{draft.entries.length === 1 ? "" : "s"}
            {draft.validation.projectedTotal !== undefined && draft.entries.length > 0 && (
              <>
                {" · "}
                {formatEther(draft.validation.projectedTotal)} C2FLR
                {draft.totalBudget > 0n && <> of {formatEther(draft.totalBudget)} budget</>}
              </>
            )}
          </span>
        </div>
      </div>

      {problems.length > 0 && filled > 0 && (
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
