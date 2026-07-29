package engine

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"

	"fidensur-extension/internal/config"
	"fidensur-extension/pkg/types"
)

// Allocation engine tests.
//
// The property these exist to protect is determinism. A verifier's whole argument is "re-run the
// published engine over the same policy and you get the published root". If Evaluate is not a pure
// function of its input, that argument collapses — so the determinism tests below matter more than
// any individual arithmetic case.

func init() {
	// Validate refuses to run without a configured deployment. Tests set one so they can exercise
	// the rest of the validation rather than stopping at the first check.
	config.ContractAddress = common.HexToAddress("0x00000000000000000000000000000000000000C0")
	config.ContractAddressSet = true
}

func addr(n int64) common.Address {
	return common.BigToAddress(big.NewInt(0x1000 + n))
}

func eth(n int64) *big.Int {
	return new(big.Int).Mul(big.NewInt(n), new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
}

// basePolicy returns a policy with the shared fields filled in; each test sets mode and entries.
func basePolicy() *types.Policy {
	return &types.Policy{
		ContractAddr: config.ContractAddress,
		RoundId:      big.NewInt(1),
		Organization: addr(999),
		TotalBudget:  eth(100),
		MinAlloc:     big.NewInt(0),
		MaxAlloc:     big.NewInt(0),
		Salt:         [32]byte{1, 2, 3},
	}
}

func explicitEntry(recipient common.Address, amount *big.Int) types.PolicyEntry {
	return types.PolicyEntry{Recipient: recipient, Weight: big.NewInt(0), Amount: amount}
}

func weightedEntry(recipient common.Address, weight int64) types.PolicyEntry {
	return types.PolicyEntry{Recipient: recipient, Weight: big.NewInt(weight), Amount: big.NewInt(0)}
}

func mustEvaluate(t *testing.T, p *types.Policy) []Allocation {
	t.Helper()
	if err := Validate(p); err != nil {
		t.Fatalf("validate: %v", err)
	}
	allocs, err := Evaluate(p)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	return allocs
}

// -----------------------------------------------------------------
// Explicit mode
// -----------------------------------------------------------------

func TestExplicitModePaysStatedAmounts(t *testing.T) {
	p := basePolicy()
	p.Mode = uint8(types.ModeExplicit)
	p.Entries = []types.PolicyEntry{
		explicitEntry(addr(3), eth(30)),
		explicitEntry(addr(1), eth(10)),
		explicitEntry(addr(2), eth(20)),
	}

	allocs := mustEvaluate(t, p)

	if len(allocs) != 3 {
		t.Fatalf("expected 3 allocations, got %d", len(allocs))
	}
	if got := SumAllocations(allocs); got.Cmp(eth(60)) != 0 {
		t.Errorf("total = %s, want %s", got, eth(60))
	}

	// Entries were supplied out of order; output must be sorted by address with indices assigned
	// afterwards, so the root cannot depend on how the author happened to order the policy.
	for i, a := range allocs {
		if a.Index != uint64(i) {
			t.Errorf("allocation %d has index %d", i, a.Index)
		}
		if i > 0 && bytesCompareAddr(allocs[i-1].Recipient, a.Recipient) >= 0 {
			t.Errorf("allocations not sorted by address at %d", i)
		}
	}
}

func TestExplicitModeAppliesCap(t *testing.T) {
	p := basePolicy()
	p.Mode = uint8(types.ModeExplicit)
	p.MaxAlloc = eth(15)
	p.Entries = []types.PolicyEntry{
		explicitEntry(addr(1), eth(10)),
		explicitEntry(addr(2), eth(50)), // capped to 15
	}

	allocs := mustEvaluate(t, p)

	if got := SumAllocations(allocs); got.Cmp(eth(25)) != 0 {
		t.Errorf("total = %s, want %s", got, eth(25))
	}
}

func TestMinAllocDropsEntriesRatherThanRoundingUp(t *testing.T) {
	p := basePolicy()
	p.Mode = uint8(types.ModeExplicit)
	p.MinAlloc = eth(5)
	p.Entries = []types.PolicyEntry{
		explicitEntry(addr(1), eth(10)),
		explicitEntry(addr(2), eth(1)), // below the floor: dropped, not raised
	}

	allocs := mustEvaluate(t, p)

	if len(allocs) != 1 {
		t.Fatalf("expected 1 allocation, got %d", len(allocs))
	}
	if allocs[0].Recipient != addr(1) {
		t.Errorf("wrong recipient survived: %s", allocs[0].Recipient.Hex())
	}
}

// -----------------------------------------------------------------
// Weighted mode
// -----------------------------------------------------------------

func TestWeightedModeSplitsInProportion(t *testing.T) {
	p := basePolicy()
	p.Mode = uint8(types.ModeWeighted)
	p.TotalBudget = eth(100)
	p.Entries = []types.PolicyEntry{
		weightedEntry(addr(1), 1),
		weightedEntry(addr(2), 2),
		weightedEntry(addr(3), 7),
	}

	allocs := mustEvaluate(t, p)

	byAddr := map[common.Address]*big.Int{}
	for _, a := range allocs {
		byAddr[a.Recipient] = a.Amount
	}

	for _, c := range []struct {
		who  common.Address
		want *big.Int
	}{
		{addr(1), eth(10)},
		{addr(2), eth(20)},
		{addr(3), eth(70)},
	} {
		if got := byAddr[c.who]; got == nil || got.Cmp(c.want) != 0 {
			t.Errorf("%s got %v, want %s", c.who.Hex(), got, c.want)
		}
	}

	if got := SumAllocations(allocs); got.Cmp(eth(100)) != 0 {
		t.Errorf("total = %s, want the full budget %s", got, eth(100))
	}
}

// TestWeightedModeNeverExceedsBudget is the property that matters most: whatever the weights,
// truncation and dust handling must not push the total over the budget.
func TestWeightedModeNeverExceedsBudget(t *testing.T) {
	weightSets := [][]int64{
		{1, 1, 1},          // 100/3 does not divide evenly
		{1, 1, 1, 1, 1, 1, 1},
		{1, 2, 3, 4, 5, 6, 7, 8, 9},
		{999999, 1, 1},
		{1},
	}

	for _, weights := range weightSets {
		p := basePolicy()
		p.Mode = uint8(types.ModeWeighted)
		p.TotalBudget = eth(100)
		p.Entries = nil
		for i, w := range weights {
			p.Entries = append(p.Entries, weightedEntry(addr(int64(i)), w))
		}

		allocs := mustEvaluate(t, p)

		if total := SumAllocations(allocs); total.Cmp(p.TotalBudget) > 0 {
			t.Errorf("weights %v: total %s exceeds budget %s", weights, total, p.TotalBudget)
		}
	}
}

func TestWeightedModeRedistributesCappedSurplus(t *testing.T) {
	p := basePolicy()
	p.Mode = uint8(types.ModeWeighted)
	p.TotalBudget = eth(100)
	p.MaxAlloc = eth(40)
	p.Entries = []types.PolicyEntry{
		weightedEntry(addr(1), 8), // would take 80, capped at 40
		weightedEntry(addr(2), 1),
		weightedEntry(addr(3), 1),
	}

	allocs := mustEvaluate(t, p)

	for _, a := range allocs {
		if a.Amount.Cmp(p.MaxAlloc) > 0 {
			t.Errorf("%s got %s, above the cap %s", a.Recipient.Hex(), a.Amount, p.MaxAlloc)
		}
	}
	if total := SumAllocations(allocs); total.Cmp(p.TotalBudget) > 0 {
		t.Errorf("total %s exceeds budget", total)
	}
}

// TestWeightedModeDustGoesSomewhereFixed pins the documented dust rule. Truncating division loses
// up to n-1 units; the rule is that the whole remainder goes to one recipient, deterministically.
func TestWeightedModeDustGoesSomewhereFixed(t *testing.T) {
	p := basePolicy()
	p.Mode = uint8(types.ModeWeighted)
	p.TotalBudget = big.NewInt(100) // not divisible by 3
	p.Entries = []types.PolicyEntry{
		weightedEntry(addr(1), 1),
		weightedEntry(addr(2), 1),
		weightedEntry(addr(3), 1),
	}

	allocs := mustEvaluate(t, p)

	if total := SumAllocations(allocs); total.Cmp(big.NewInt(100)) != 0 {
		t.Errorf("dust was lost: total %s, want 100", total)
	}
}

// -----------------------------------------------------------------
// Tiered mode
// -----------------------------------------------------------------

func TestTieredModeUsesBandAmounts(t *testing.T) {
	p := basePolicy()
	p.Mode = uint8(types.ModeTiered)
	p.TotalBudget = eth(100)
	p.Bands = []*big.Int{eth(10), eth(25), eth(40)}
	p.Entries = []types.PolicyEntry{
		weightedEntry(addr(1), 0),
		weightedEntry(addr(2), 2),
		weightedEntry(addr(3), 1),
	}

	allocs := mustEvaluate(t, p)

	byAddr := map[common.Address]*big.Int{}
	for _, a := range allocs {
		byAddr[a.Recipient] = a.Amount
	}

	if byAddr[addr(1)].Cmp(eth(10)) != 0 {
		t.Errorf("band 0 wrong: %s", byAddr[addr(1)])
	}
	if byAddr[addr(2)].Cmp(eth(40)) != 0 {
		t.Errorf("band 2 wrong: %s", byAddr[addr(2)])
	}
	if byAddr[addr(3)].Cmp(eth(25)) != 0 {
		t.Errorf("band 1 wrong: %s", byAddr[addr(3)])
	}
}

func TestTieredModeRejectsOutOfRangeBand(t *testing.T) {
	p := basePolicy()
	p.Mode = uint8(types.ModeTiered)
	p.Bands = []*big.Int{eth(10)}
	p.Entries = []types.PolicyEntry{weightedEntry(addr(1), 5)}

	if err := Validate(p); err == nil {
		t.Error("expected validation to reject a band index past the table")
	}
}

// -----------------------------------------------------------------
// Determinism — the property the whole verification story rests on
// -----------------------------------------------------------------

func TestEvaluateIsDeterministicAcrossRuns(t *testing.T) {
	build := func() *types.Policy {
		p := basePolicy()
		p.Mode = uint8(types.ModeWeighted)
		p.TotalBudget = eth(1000)
		p.Entries = nil
		for i := 0; i < 50; i++ {
			p.Entries = append(p.Entries, weightedEntry(addr(int64(i)), int64(i%7+1)))
		}
		return p
	}

	first := rootOf(t, build())
	for run := 0; run < 20; run++ {
		if got := rootOf(t, build()); got != first {
			t.Fatalf("run %d produced root %s, first run produced %s", run, got.Hex(), first.Hex())
		}
	}
}

// TestEvaluateIgnoresInputOrdering is why entries are sorted before indices are assigned: two
// organizations writing the same policy with rows in a different order must reach the same root.
func TestEvaluateIgnoresInputOrdering(t *testing.T) {
	// Amounts 1..20 ether sum to 210, so the budget must cover that — the engine rejects an
	// explicit policy whose amounts exceed the budget, which is a separate rule from the one
	// under test here.
	const budget = 210

	forward := basePolicy()
	forward.Mode = uint8(types.ModeExplicit)
	forward.TotalBudget = eth(budget)
	for i := 0; i < 20; i++ {
		forward.Entries = append(forward.Entries, explicitEntry(addr(int64(i)), eth(int64(i+1))))
	}

	reversed := basePolicy()
	reversed.Mode = uint8(types.ModeExplicit)
	reversed.TotalBudget = eth(budget)
	for i := 19; i >= 0; i-- {
		reversed.Entries = append(reversed.Entries, explicitEntry(addr(int64(i)), eth(int64(i+1))))
	}

	if a, b := rootOf(t, forward), rootOf(t, reversed); a != b {
		t.Errorf("input ordering changed the root:\n  forward:  %s\n  reversed: %s", a.Hex(), b.Hex())
	}
}

func rootOf(t *testing.T, p *types.Policy) common.Hash {
	t.Helper()

	allocs := mustEvaluate(t, p)
	leaves := make([]common.Hash, len(allocs))
	for i, a := range allocs {
		leaves[i] = LeafHash(p.RoundId, a.Index, a.Recipient, a.Amount)
	}

	tree := BuildMerkleTree(leaves)
	if tree == nil {
		t.Fatal("nil tree")
	}
	return tree.Root()
}

// -----------------------------------------------------------------
// Validation — untrusted input
// -----------------------------------------------------------------

func TestValidateRejectsWrongContract(t *testing.T) {
	p := basePolicy()
	p.Mode = uint8(types.ModeExplicit)
	p.ContractAddr = common.HexToAddress("0x00000000000000000000000000000000000000FF")
	p.Entries = []types.PolicyEntry{explicitEntry(addr(1), eth(1))}

	// Stops a ciphertext encrypted for one deployment being replayed against another on the same
	// TEE. The on-chain commitment check cannot catch this — it binds a ciphertext to a round.
	if err := Validate(p); err == nil {
		t.Error("expected rejection of a policy targeting another deployment")
	}
}

func TestValidateRejectsDuplicateRecipients(t *testing.T) {
	p := basePolicy()
	p.Mode = uint8(types.ModeExplicit)
	p.Entries = []types.PolicyEntry{
		explicitEntry(addr(1), eth(1)),
		explicitEntry(addr(1), eth(2)), // same address twice would mean two claimable leaves
	}

	if err := Validate(p); err == nil {
		t.Error("expected rejection of duplicate recipients")
	}
}

func TestValidateRejectsZeroAddress(t *testing.T) {
	p := basePolicy()
	p.Mode = uint8(types.ModeExplicit)
	p.Entries = []types.PolicyEntry{explicitEntry(common.Address{}, eth(1))}

	if err := Validate(p); err == nil {
		t.Error("expected rejection of the zero address")
	}
}

func TestValidateRejectsOverBudgetExplicitPolicy(t *testing.T) {
	p := basePolicy()
	p.Mode = uint8(types.ModeExplicit)
	p.TotalBudget = eth(10)
	p.Entries = []types.PolicyEntry{
		explicitEntry(addr(1), eth(8)),
		explicitEntry(addr(2), eth(8)),
	}

	if err := Validate(p); err == nil {
		t.Error("expected rejection when explicit amounts exceed the budget")
	}
}

// TestValidateRejectsFieldsTheModeIgnores is stricter than strictly necessary, deliberately: a
// policy setting Amount in weighted mode almost certainly means its author expected Amount to be
// honoured, and quietly ignoring it would produce a confidently wrong payroll.
func TestValidateRejectsFieldsTheModeIgnores(t *testing.T) {
	weighted := basePolicy()
	weighted.Mode = uint8(types.ModeWeighted)
	weighted.Entries = []types.PolicyEntry{
		{Recipient: addr(1), Weight: big.NewInt(1), Amount: eth(5)},
	}
	if err := Validate(weighted); err == nil {
		t.Error("weighted mode should reject a populated Amount")
	}

	explicit := basePolicy()
	explicit.Mode = uint8(types.ModeExplicit)
	explicit.Entries = []types.PolicyEntry{
		{Recipient: addr(1), Weight: big.NewInt(3), Amount: eth(5)},
	}
	if err := Validate(explicit); err == nil {
		t.Error("explicit mode should reject a populated Weight")
	}
}

func TestValidateRejectsEmptyAndOversizedPolicies(t *testing.T) {
	empty := basePolicy()
	empty.Mode = uint8(types.ModeExplicit)
	if err := Validate(empty); err == nil {
		t.Error("expected rejection of a policy with no entries")
	}

	oversized := basePolicy()
	oversized.Mode = uint8(types.ModeExplicit)
	oversized.TotalBudget = new(big.Int).Lsh(big.NewInt(1), 200)
	for i := 0; i <= config.MaxRecipients; i++ {
		oversized.Entries = append(oversized.Entries, explicitEntry(addr(int64(i)), big.NewInt(1)))
	}
	if err := Validate(oversized); err == nil {
		t.Errorf("expected rejection above the %d-recipient limit", config.MaxRecipients)
	}
}

func TestValidateRejectsUnknownMode(t *testing.T) {
	p := basePolicy()
	p.Mode = 99
	p.Entries = []types.PolicyEntry{explicitEntry(addr(1), eth(1))}

	if err := Validate(p); err == nil {
		t.Error("expected rejection of an unknown allocation mode")
	}
}

func bytesCompareAddr(a, b common.Address) int {
	for i := 0; i < common.AddressLength; i++ {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}
