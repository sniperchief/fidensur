package engine

import (
	"bytes"
	"fmt"
	"math/big"
	"sort"

	"github.com/ethereum/go-ethereum/common"

	"fidensur-extension/internal/config"
	"fidensur-extension/pkg/types"
)

// Allocation is one row of a computed allocation table.
type Allocation struct {
	Index     uint64
	Recipient common.Address
	Amount    *big.Int
}

// Evaluate turns a validated policy into a deterministic allocation table.
//
// Determinism is the contract this function must honour above all else: the same policy bytes must
// produce a byte-identical table — and therefore a byte-identical Merkle root — on any machine, in
// any process, at any time. A verifier's entire argument is that re-running the published engine
// over the same input reproduces the published root.
//
// What that rules out, concretely:
//
//   - **Floating point.** Every amount is math/big integer arithmetic. A float64 cannot represent
//     wei amounts exactly, and its rounding is not portable in the way integer truncation is.
//   - **Map iteration.** Go randomizes it deliberately. Nothing here iterates a map to build output;
//     the duplicate check reads a map but never orders anything by it.
//   - **Input ordering.** Entries are sorted by recipient address before indices are assigned, so
//     shuffling the policy's rows cannot change the root.
//   - **Ambiguous remainders.** Truncating division leaves dust. The rule is fixed and stated:
//     the whole remainder goes to the lowest-indexed recipient that can absorb it under the cap.
//
// The policy is untrusted input. Validate() must have run first; Evaluate assumes only what
// Validate guarantees.
func Evaluate(p *types.Policy) ([]Allocation, error) {
	amounts, err := computeAmounts(p)
	if err != nil {
		return nil, err
	}

	// Apply the floor, dropping rather than rounding up. Paying someone more than the policy
	// computed would be a worse surprise than not paying them, and the public recipient count makes
	// the drop visible in aggregate.
	kept := make([]Allocation, 0, len(amounts))
	for _, a := range amounts {
		if a.Amount.Sign() <= 0 {
			continue
		}
		if p.MinAlloc != nil && p.MinAlloc.Sign() > 0 && a.Amount.Cmp(p.MinAlloc) < 0 {
			continue
		}
		kept = append(kept, a)
	}

	if len(kept) == 0 {
		return nil, fmt.Errorf("policy allocates nothing: every entry is zero or below minAlloc")
	}

	// Sort by recipient address, then assign indices. Sorting on the address (a total order over
	// distinct values, and Validate has rejected duplicates) makes the ordering independent of how
	// the author happened to write the policy.
	sort.Slice(kept, func(i, j int) bool {
		return bytes.Compare(kept[i].Recipient.Bytes(), kept[j].Recipient.Bytes()) < 0
	})
	for i := range kept {
		kept[i].Index = uint64(i)
	}

	// The budget ceiling is re-checked after every transformation, not assumed from the mode's
	// arithmetic. Fidensur.finalizeRound enforces the same bound against actual funding, so a bug
	// here cannot create an unpayable obligation — but it should not reach the chain either.
	total := SumAllocations(kept)
	if total.Cmp(p.TotalBudget) > 0 {
		return nil, fmt.Errorf("allocations total %s exceed budget %s", total, p.TotalBudget)
	}

	return kept, nil
}

// computeAmounts dispatches on the policy mode, before the floor and indexing are applied.
func computeAmounts(p *types.Policy) ([]Allocation, error) {
	switch types.AllocationMode(p.Mode) {
	case types.ModeExplicit:
		return explicitAmounts(p)
	case types.ModeWeighted:
		return weightedAmounts(p)
	case types.ModeTiered:
		return tieredAmounts(p)
	default:
		return nil, fmt.Errorf("unsupported allocation mode %d", p.Mode)
	}
}

// explicitAmounts takes each entry's Amount verbatim, capped by MaxAlloc.
func explicitAmounts(p *types.Policy) ([]Allocation, error) {
	out := make([]Allocation, len(p.Entries))
	for i, e := range p.Entries {
		amount := new(big.Int).Set(e.Amount)
		if capped(p.MaxAlloc) && amount.Cmp(p.MaxAlloc) > 0 {
			amount.Set(p.MaxAlloc)
		}
		out[i] = Allocation{Recipient: e.Recipient, Amount: amount}
	}
	return out, nil
}

// tieredAmounts assigns each entry the amount of the band its Weight indexes.
//
// The band table lives only inside the policy, so an organization can pay by salary band without
// publishing the bands — which is usually the most sensitive part of a compensation scheme.
func tieredAmounts(p *types.Policy) ([]Allocation, error) {
	out := make([]Allocation, len(p.Entries))
	for i, e := range p.Entries {
		if !e.Weight.IsUint64() || e.Weight.Uint64() >= uint64(len(p.Bands)) {
			return nil, fmt.Errorf("entry %d: band index %s out of range (%d bands)", i, e.Weight, len(p.Bands))
		}
		amount := new(big.Int).Set(p.Bands[e.Weight.Uint64()])
		if capped(p.MaxAlloc) && amount.Cmp(p.MaxAlloc) > 0 {
			amount.Set(p.MaxAlloc)
		}
		out[i] = Allocation{Recipient: e.Recipient, Amount: amount}
	}
	return out, nil
}

// weightedAmounts splits TotalBudget in proportion to Weight, applying MaxAlloc and redistributing
// what the caps free up.
//
//	amountᵢ = floor(remainingBudget × weightᵢ / Σ uncapped weight)
//
// Capping is iterative because redistributing to the uncapped entries can push some of *them* over
// the cap. Each pass caps at least one more entry, so the loop is bounded by the entry count; the
// explicit bound is belt-and-braces against a subtle non-termination in untrusted-input handling.
func weightedAmounts(p *types.Policy) ([]Allocation, error) {
	n := len(p.Entries)
	amounts := make([]*big.Int, n)
	isCapped := make([]bool, n)
	for i := range amounts {
		amounts[i] = new(big.Int)
	}

	remaining := new(big.Int).Set(p.TotalBudget)

	for pass := 0; pass <= n; pass++ {
		// Total weight of the entries still free to absorb budget.
		weightSum := new(big.Int)
		for i, e := range p.Entries {
			if !isCapped[i] {
				weightSum.Add(weightSum, e.Weight)
			}
		}
		if weightSum.Sign() == 0 {
			// Everything is capped, or every uncapped entry has zero weight. Either way there is
			// nothing left to distribute; the surplus stays unallocated and returns to the
			// organization when the round closes.
			break
		}

		newlyCapped := false
		for i, e := range p.Entries {
			if isCapped[i] {
				continue
			}
			// floor(remaining × weight / weightSum) — truncating division, consistently.
			share := new(big.Int).Mul(remaining, e.Weight)
			share.Div(share, weightSum)

			if capped(p.MaxAlloc) && share.Cmp(p.MaxAlloc) > 0 {
				share.Set(p.MaxAlloc)
				isCapped[i] = true
				newlyCapped = true
			}
			amounts[i] = share
		}

		if !newlyCapped {
			break
		}

		// Recompute what is left for the entries still uncapped.
		remaining.Set(p.TotalBudget)
		for i := range amounts {
			if isCapped[i] {
				remaining.Sub(remaining, amounts[i])
			}
		}
		if remaining.Sign() < 0 {
			return nil, fmt.Errorf("internal: capped allocations exceed budget")
		}
	}

	out := make([]Allocation, n)
	for i, e := range p.Entries {
		out[i] = Allocation{Recipient: e.Recipient, Amount: amounts[i]}
	}

	distributeDust(p, out, isCapped)
	return out, nil
}

// distributeDust hands the truncation remainder to a single recipient.
//
// Truncating division loses up to (n-1) units of the smallest denomination. Splitting the dust
// "fairly" would need another tie-break rule and reintroduce the same rounding problem one level
// down, so the rule here is deliberately blunt and fully specified: the entire remainder goes to
// the lowest-indexed uncapped recipient that can absorb it without breaching MaxAlloc. If no
// recipient can, the dust stays unallocated and returns to the organization at close.
//
// "Lowest-indexed" here means lowest position in the policy as written. Evaluate re-sorts by
// address afterwards, so the choice is stable for a given policy but is not address-ordered — the
// property that matters is that it is a fixed function of the input, not that it is fair.
func distributeDust(p *types.Policy, out []Allocation, isCapped []bool) {
	allocated := new(big.Int)
	for _, a := range out {
		allocated.Add(allocated, a.Amount)
	}

	dust := new(big.Int).Sub(p.TotalBudget, allocated)
	if dust.Sign() <= 0 {
		return
	}

	for i := range out {
		if isCapped[i] {
			continue
		}
		if p.Entries[i].Weight.Sign() == 0 {
			continue // zero-weight entries were never entitled to a share
		}
		candidate := new(big.Int).Add(out[i].Amount, dust)
		if capped(p.MaxAlloc) && candidate.Cmp(p.MaxAlloc) > 0 {
			continue
		}
		out[i].Amount = candidate
		return
	}
	// No recipient could absorb it; the surplus returns to the organization at close.
}

// SumAllocations totals an allocation table.
func SumAllocations(allocs []Allocation) *big.Int {
	total := new(big.Int)
	for _, a := range allocs {
		total.Add(total, a.Amount)
	}
	return total
}

// capped reports whether a cap is in force. Zero and nil both mean "no cap".
func capped(v *big.Int) bool {
	return v != nil && v.Sign() > 0
}

// Validate checks a decoded policy before any of it is used.
//
// Everything reaching this function came from an on-chain instruction payload and is untrusted, so
// every field is checked rather than assumed — including the ones that "obviously" cannot be wrong,
// because a nil *big.Int from a malformed ABI decode panics rather than misbehaving quietly.
func Validate(p *types.Policy) error {
	if !config.ContractAddressSet {
		return fmt.Errorf("extension misconfigured: FIDENSUR_CONTRACT is not set")
	}
	if p.ContractAddr != config.ContractAddress {
		// Stops a ciphertext encrypted for one deployment being replayed against another served by
		// the same TEE. The on-chain commitment check cannot catch this: it binds the ciphertext to
		// a round, not to a contract.
		return fmt.Errorf("policy targets contract %s, this engine serves %s",
			p.ContractAddr.Hex(), config.ContractAddress.Hex())
	}

	if p.RoundId == nil {
		return fmt.Errorf("roundId must be present")
	}
	if p.TotalBudget == nil || p.TotalBudget.Sign() <= 0 {
		return fmt.Errorf("totalBudget must be positive")
	}
	if p.MinAlloc != nil && p.MinAlloc.Sign() < 0 {
		return fmt.Errorf("minAlloc must not be negative")
	}
	if p.MaxAlloc != nil && p.MaxAlloc.Sign() < 0 {
		return fmt.Errorf("maxAlloc must not be negative")
	}
	if capped(p.MaxAlloc) && p.MinAlloc != nil && p.MinAlloc.Sign() > 0 && p.MinAlloc.Cmp(p.MaxAlloc) > 0 {
		return fmt.Errorf("minAlloc %s exceeds maxAlloc %s", p.MinAlloc, p.MaxAlloc)
	}

	if len(p.Entries) == 0 {
		return fmt.Errorf("policy has no entries")
	}
	if len(p.Entries) > config.MaxRecipients {
		return fmt.Errorf("policy has %d entries, limit is %d", len(p.Entries), config.MaxRecipients)
	}

	seen := make(map[common.Address]int, len(p.Entries))
	for i, e := range p.Entries {
		if e.Recipient == (common.Address{}) {
			return fmt.Errorf("entry %d: recipient must not be the zero address", i)
		}
		if prev, dup := seen[e.Recipient]; dup {
			// A duplicate would produce two leaves for one address, letting that recipient claim
			// twice. Rejecting is the only safe reading — merging the rows would silently rewrite
			// the organization's intent.
			return fmt.Errorf("entry %d duplicates recipient %s from entry %d", i, e.Recipient.Hex(), prev)
		}
		seen[e.Recipient] = i

		if e.Weight == nil || e.Weight.Sign() < 0 {
			return fmt.Errorf("entry %d: weight must be present and non-negative", i)
		}
		if e.Amount == nil || e.Amount.Sign() < 0 {
			return fmt.Errorf("entry %d: amount must be present and non-negative", i)
		}
	}

	return validateMode(p)
}

// validateMode enforces the per-mode field rules.
//
// A field the mode ignores must be zero. This is stricter than necessary, on purpose: a policy that
// sets Amount in weighted mode almost certainly means its author expected Amount to be honoured,
// and silently ignoring it would produce a confidently wrong payroll.
func validateMode(p *types.Policy) error {
	switch types.AllocationMode(p.Mode) {
	case types.ModeExplicit:
		total := new(big.Int)
		for i, e := range p.Entries {
			if e.Weight.Sign() != 0 {
				return fmt.Errorf("entry %d: weight must be zero in explicit mode", i)
			}
			total.Add(total, e.Amount)
		}
		if total.Cmp(p.TotalBudget) > 0 {
			return fmt.Errorf("explicit amounts total %s exceed budget %s", total, p.TotalBudget)
		}
		if len(p.Bands) != 0 {
			return fmt.Errorf("bands must be empty in explicit mode")
		}

	case types.ModeWeighted:
		weightSum := new(big.Int)
		for i, e := range p.Entries {
			if e.Amount.Sign() != 0 {
				return fmt.Errorf("entry %d: amount must be zero in weighted mode", i)
			}
			weightSum.Add(weightSum, e.Weight)
		}
		if weightSum.Sign() == 0 {
			return fmt.Errorf("weighted mode needs at least one positive weight")
		}
		if len(p.Bands) != 0 {
			return fmt.Errorf("bands must be empty in weighted mode")
		}

	case types.ModeTiered:
		if len(p.Bands) == 0 {
			return fmt.Errorf("tiered mode needs at least one band")
		}
		if len(p.Bands) > config.MaxRecipients {
			return fmt.Errorf("too many bands: %d", len(p.Bands))
		}
		total := new(big.Int)
		for i, b := range p.Bands {
			if b == nil || b.Sign() < 0 {
				return fmt.Errorf("band %d: amount must be present and non-negative", i)
			}
		}
		for i, e := range p.Entries {
			if e.Amount.Sign() != 0 {
				return fmt.Errorf("entry %d: amount must be zero in tiered mode", i)
			}
			if !e.Weight.IsUint64() || e.Weight.Uint64() >= uint64(len(p.Bands)) {
				return fmt.Errorf("entry %d: band index %s out of range (%d bands)", i, e.Weight, len(p.Bands))
			}
			total.Add(total, p.Bands[e.Weight.Uint64()])
		}
		if total.Cmp(p.TotalBudget) > 0 {
			return fmt.Errorf("tiered amounts total %s exceed budget %s", total, p.TotalBudget)
		}

	default:
		return fmt.Errorf("unsupported allocation mode %d", p.Mode)
	}

	return nil
}
