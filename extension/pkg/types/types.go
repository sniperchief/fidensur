// Package types defines the wire types Fidensur's instructions and results use.
//
// These are the shapes an integrator needs in order to build a policy, read a result, or decode an
// instruction, so the package is deliberately dependency-light and importable on its own.
//
// Two encodings are in play, and the choice per payload is not arbitrary:
//
//   - **ABI** for anything a contract must read. `Fidensur.finalizeRound` abi.decodes the allocation
//     result, so the engine must emit exactly the layout Solidity expects.
//   - **JSON** for anything only a human or a frontend reads.
//
// `ActionResult.Data` is hashed and signed byte-for-byte, so a change to any layout here is a
// breaking change to on-chain verification, not merely to a serialization detail.
package types

import (
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

// AllocationMode selects how the engine turns policy entries into amounts.
type AllocationMode uint8

const (
	// ModeExplicit takes each entry's Amount verbatim. Simplest, still fully confidential.
	ModeExplicit AllocationMode = 0

	// ModeWeighted splits TotalBudget in proportion to each entry's Weight.
	ModeWeighted AllocationMode = 1

	// ModeTiered assigns each entry the amount of the band its Weight indexes.
	// Models salary bands without ever revealing the band table.
	ModeTiered AllocationMode = 2
)

// PolicyEntry is one row of a confidential allocation policy.
//
// Which fields matter depends on the mode: Amount for ModeExplicit, Weight for ModeWeighted, and
// Weight-as-band-index for ModeTiered. Unused fields must be zero — the engine rejects a policy
// that sets a field its mode ignores, since a populated-but-ignored field almost always means the
// author misunderstood the mode.
type PolicyEntry struct {
	Recipient common.Address `abi:"recipient" json:"recipient"`
	Weight    *big.Int       `abi:"weight"    json:"weight"`
	Amount    *big.Int       `abi:"amount"    json:"amount"`
}

// Policy is the confidential input to a COMPUTE instruction.
//
// It is ABI-encoded, then ECIES-encrypted to the extension's public key, and only the ciphertext
// ever leaves the author's machine. The on-chain record is keccak256 of that ciphertext.
type Policy struct {
	// ContractAddr is the Fidensur deployment this policy targets. The engine refuses a policy
	// naming a different contract, which stops a ciphertext being replayed against another
	// deployment served by the same TEE.
	ContractAddr common.Address `abi:"contractAddr" json:"contractAddr"`

	// RoundId is the round this policy allocates. Echoed into the signed result and checked
	// on-chain against the round the instruction came from.
	RoundId *big.Int `abi:"roundId" json:"roundId"`

	// Organization is the address that created the round. Carried for auditability: it lets a
	// later reveal of the policy be checked against who actually owned the round.
	Organization common.Address `abi:"organization" json:"organization"`

	Mode uint8 `abi:"mode" json:"mode"`

	// TotalBudget caps the sum of all allocations, and in ModeWeighted is the amount being split.
	TotalBudget *big.Int `abi:"totalBudget" json:"totalBudget"`

	// MinAlloc drops entries computing below it. Zero disables the floor.
	//
	// Entries are dropped rather than rounded up: silently paying someone more than the policy
	// computed would be a worse surprise than not paying them, and the recipient count in the
	// public result makes the drop visible in aggregate.
	MinAlloc *big.Int `abi:"minAlloc" json:"minAlloc"`

	// MaxAlloc caps any single allocation. Zero disables the cap. In ModeWeighted the amount a cap
	// frees up is redistributed among the uncapped entries.
	MaxAlloc *big.Int `abi:"maxAlloc" json:"maxAlloc"`

	// Bands holds the per-recipient amount for each tier, used only by ModeTiered.
	Bands []*big.Int `abi:"bands" json:"bands"`

	// Salt blinds the commitment. Without it, an observer who guessed a full policy could confirm
	// the guess by recomputing the hash — the entire policy space for a small, known recipient set
	// is enumerable.
	Salt [32]byte `abi:"salt" json:"salt"`

	Entries []PolicyEntry `abi:"entries" json:"entries"`
}

// DiscloseRequest is the ABI payload of a DISCLOSE instruction.
//
// Requester is stamped by the contract from msg.sender. Since the registry admits instructions only
// from the registered InstructionSender, the engine treats it as authenticated and needs no
// signature of its own.
type DiscloseRequest struct {
	RoundId          *big.Int       `abi:"roundId"          json:"roundId"`
	ContractAddr     common.Address `abi:"contractAddr"     json:"contractAddr"`
	Requester        common.Address `abi:"requester"        json:"requester"`
	PolicyCommitment common.Hash    `abi:"policyCommitment" json:"policyCommitment"`
	DisclosureKey    []byte         `abi:"disclosureKey"    json:"disclosureKey"`
}

// AttestRequest is the ABI payload of an ATTEST instruction.
type AttestRequest struct {
	RoundId          *big.Int       `abi:"roundId"          json:"roundId"`
	ContractAddr     common.Address `abi:"contractAddr"     json:"contractAddr"`
	PolicyCommitment common.Hash    `abi:"policyCommitment" json:"policyCommitment"`
}

// Disclosure is the plaintext a recipient recovers from a DISCLOSE reply.
//
// JSON rather than ABI: nothing on-chain reads it, and a recipient decrypting it in a browser is
// better served by a self-describing format.
type Disclosure struct {
	RoundId     string   `json:"roundId"`
	Index       uint64   `json:"index"`
	Recipient   string   `json:"recipient"`
	Amount      string   `json:"amount"`      // decimal string; amounts exceed float64 precision
	Proof       []string `json:"proof"`       // 0x-prefixed sibling hashes, leaf level first
	MerkleRoot  string   `json:"merkleRoot"`  // lets the recipient check the proof before claiming
	TotalCount  uint32   `json:"totalCount"`  // recipients in the round
	EngineVer   string   `json:"engineVersion"`
	ComputedAt  int64    `json:"computedAt"`
}

// State is the extension's public snapshot, served by GET /state.
//
// Aggregates only. Nothing here maps a round to a recipient, an amount, or a policy — a state
// endpoint that leaked those would undo the entire design.
type State struct {
	EngineVersion    string `json:"engineVersion"`
	RoundsComputed   int    `json:"roundsComputed"`
	ComputeRequests  int    `json:"computeRequests"`
	DiscloseRequests int    `json:"discloseRequests"`
	AttestRequests   int    `json:"attestRequests"`
	FailedRequests   int    `json:"failedRequests"`
	LastComputedAt   int64  `json:"lastComputedAt"`
	ContractAddress  string `json:"contractAddress"`
}

// StateResponse is the envelope returned by GET /state.
//
// StateVersion is bytes32 here while ActionResult.Version is a plain string. The asymmetry is real
// and is part of the FCC container contract; see docs/fcc-research.md §6.4.
type StateResponse struct {
	StateVersion common.Hash `json:"stateVersion"`
	State        State       `json:"state"`
}

// --- ABI layouts ---
//
// These mirror the structs in contracts/Fidensur.sol. Solidity's abi.encode of a struct whose
// fields are all static is byte-identical to abi.encode of the fields in order, which is why the
// allocation result can be declared as a flat argument list here and decoded into a struct there.

var (
	// PolicyArg describes the ABI layout of Policy.
	PolicyArg abi.Argument

	// DiscloseRequestArg describes the ABI layout of Fidensur.DiscloseMessage.
	DiscloseRequestArg abi.Argument

	// AttestRequestArg describes the ABI layout of Fidensur.AttestMessage.
	AttestRequestArg abi.Argument

	// AllocationResultArgs is the flat tuple Fidensur.finalizeRound decodes:
	//   (address contractAddr, uint256 roundId, bytes32 policyCommitment, bytes32 merkleRoot,
	//    uint256 totalAllocated, uint32 recipientCount, bytes32 engineVersion)
	AllocationResultArgs abi.Arguments

	// DisclosureResultArgs is the flat tuple a DISCLOSE reply carries:
	//   (address requester, uint256 roundId, bytes ciphertext)
	DisclosureResultArgs abi.Arguments
)

func init() {
	policyTy, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "contractAddr", Type: "address"},
		{Name: "roundId", Type: "uint256"},
		{Name: "organization", Type: "address"},
		{Name: "mode", Type: "uint8"},
		{Name: "totalBudget", Type: "uint256"},
		{Name: "minAlloc", Type: "uint256"},
		{Name: "maxAlloc", Type: "uint256"},
		{Name: "bands", Type: "uint256[]"},
		{Name: "salt", Type: "bytes32"},
		{Name: "entries", Type: "tuple[]", Components: []abi.ArgumentMarshaling{
			{Name: "recipient", Type: "address"},
			{Name: "weight", Type: "uint256"},
			{Name: "amount", Type: "uint256"},
		}},
	})
	if err != nil {
		panic("types: building Policy ABI type: " + err.Error())
	}
	PolicyArg = abi.Argument{Type: policyTy}

	discloseTy, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "roundId", Type: "uint256"},
		{Name: "contractAddr", Type: "address"},
		{Name: "requester", Type: "address"},
		{Name: "policyCommitment", Type: "bytes32"},
		{Name: "disclosureKey", Type: "bytes"},
	})
	if err != nil {
		panic("types: building DiscloseRequest ABI type: " + err.Error())
	}
	DiscloseRequestArg = abi.Argument{Type: discloseTy}

	attestTy, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "roundId", Type: "uint256"},
		{Name: "contractAddr", Type: "address"},
		{Name: "policyCommitment", Type: "bytes32"},
	})
	if err != nil {
		panic("types: building AttestRequest ABI type: " + err.Error())
	}
	AttestRequestArg = abi.Argument{Type: attestTy}

	addressTy := mustType("address")
	uint256Ty := mustType("uint256")
	uint32Ty := mustType("uint32")
	bytes32Ty := mustType("bytes32")
	bytesTy := mustType("bytes")

	AllocationResultArgs = abi.Arguments{
		{Name: "contractAddr", Type: addressTy},
		{Name: "roundId", Type: uint256Ty},
		{Name: "policyCommitment", Type: bytes32Ty},
		{Name: "merkleRoot", Type: bytes32Ty},
		{Name: "totalAllocated", Type: uint256Ty},
		{Name: "recipientCount", Type: uint32Ty},
		{Name: "engineVersion", Type: bytes32Ty},
	}

	DisclosureResultArgs = abi.Arguments{
		{Name: "requester", Type: addressTy},
		{Name: "roundId", Type: uint256Ty},
		{Name: "ciphertext", Type: bytesTy},
	}
}

func mustType(solType string) abi.Type {
	t, err := abi.NewType(solType, "", nil)
	if err != nil {
		panic("types: building ABI type " + solType + ": " + err.Error())
	}
	return t
}
