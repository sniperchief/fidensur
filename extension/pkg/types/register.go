package types

import (
	"encoding/hex"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"

	"fidensur-extension/pkg/decoder"
)

// Decoder registrations for the types server.
//
// The types server renders raw instruction bytes as readable JSON for the verification explorer.
// For Fidensur the interesting question is what it must *refuse* to render: the COMPUTE message is
// an encrypted policy, and a decoder that unwrapped it would put the confidential payload on a
// public HTTP endpoint. So the COMPUTE message decoder deliberately reports shape only — encrypted,
// length, hex — following the pattern fce-weather-insurance uses for its private policies.
//
// The OPType/OPCommand strings here are the third copy of the routing identifiers; the others are
// in contracts/Fidensur.sol and extension/internal/config/config.go. All three must agree.

// RegisterDecoders wires up every decoder this extension exposes.
func RegisterDecoders(r *decoder.Registry) {
	// COMPUTE message — ECIES ciphertext. Shape only, never content.
	r.Register(
		decoder.RegistryKey{OPType: "ALLOC", OPCommand: "COMPUTE", Kind: decoder.KindMessage},
		encryptedDecoder{label: "policy"},
	)
	// COMPUTE result — the public aggregate that finalizeRound consumes.
	r.Register(
		decoder.RegistryKey{OPType: "ALLOC", OPCommand: "COMPUTE", Kind: decoder.KindResult},
		allocationResultDecoder{},
	)

	// DISCLOSE message — plaintext routing fields; the reply is what carries the secret.
	r.Register(
		decoder.RegistryKey{OPType: "ALLOC", OPCommand: "DISCLOSE", Kind: decoder.KindMessage},
		decoder.NewABIDecoder[DiscloseRequest](DiscloseRequestArg),
	)
	// DISCLOSE result — the ciphertext is reported as opaque bytes.
	r.Register(
		decoder.RegistryKey{OPType: "ALLOC", OPCommand: "DISCLOSE", Kind: decoder.KindResult},
		disclosureResultDecoder{},
	)

	// ATTEST message and result.
	r.Register(
		decoder.RegistryKey{OPType: "ALLOC", OPCommand: "ATTEST", Kind: decoder.KindMessage},
		decoder.NewABIDecoder[AttestRequest](AttestRequestArg),
	)
	r.Register(
		decoder.RegistryKey{OPType: "ALLOC", OPCommand: "ATTEST", Kind: decoder.KindResult},
		allocationResultDecoder{},
	)

	// Plaintext policy, for tooling that holds the pre-encryption bytes — an organization
	// re-checking what it committed to, or an auditor a round has been revealed to. Never reached
	// by an on-chain instruction; there is no OPCommand named POLICY_PLAINTEXT.
	r.Register(
		decoder.RegistryKey{OPType: "ALLOC", OPCommand: "POLICY_PLAINTEXT", Kind: decoder.KindMessage},
		decoder.NewABIDecoder[Policy](PolicyArg),
	)
}

// encryptedDecoder reports the shape of an encrypted payload without attempting to read it.
//
// Length is disclosed and that is a real, if minor, leak: ciphertext size scales with the recipient
// count, so an observer learns the round's approximate size. It is already inferable from the
// on-chain instruction data, and docs/architecture.md §9.4 records it as accepted.
type encryptedDecoder struct {
	label string
}

func (d encryptedDecoder) Decode(data []byte) (any, error) {
	return map[string]any{
		"encrypted":   true,
		"payload":     d.label,
		"length":      len(data),
		"hex":         "0x" + hex.EncodeToString(data),
		"description": "ECIES ciphertext, decryptable only inside the TEE",
	}, nil
}

// AllocationResult is the decoded public aggregate.
type AllocationResult struct {
	ContractAddr     common.Address `json:"contractAddr"`
	RoundId          *big.Int       `json:"roundId"`
	PolicyCommitment common.Hash    `json:"policyCommitment"`
	MerkleRoot       common.Hash    `json:"merkleRoot"`
	TotalAllocated   *big.Int       `json:"totalAllocated"`
	RecipientCount   uint32         `json:"recipientCount"`
	EngineVersion    common.Hash    `json:"engineVersion"`
}

type allocationResultDecoder struct{}

func (allocationResultDecoder) Decode(data []byte) (any, error) {
	vals, err := AllocationResultArgs.Unpack(data)
	if err != nil {
		return nil, err
	}
	if len(vals) != 7 {
		return nil, fmt.Errorf("expected 7 values, got %d", len(vals))
	}
	// go-ethereum unpacks a bytes32 as [32]byte. common.Hash is defined as [32]byte, so this is a
	// direct type conversion — slicing the assertion result would not compile, since the value is
	// unaddressable.
	return AllocationResult{
		ContractAddr:     vals[0].(common.Address),
		RoundId:          vals[1].(*big.Int),
		PolicyCommitment: common.Hash(vals[2].([32]byte)),
		MerkleRoot:       common.Hash(vals[3].([32]byte)),
		TotalAllocated:   vals[4].(*big.Int),
		RecipientCount:   vals[5].(uint32),
		EngineVersion:    common.Hash(vals[6].([32]byte)),
	}, nil
}

type disclosureResultDecoder struct{}

func (disclosureResultDecoder) Decode(data []byte) (any, error) {
	vals, err := DisclosureResultArgs.Unpack(data)
	if err != nil {
		return nil, err
	}
	if len(vals) != 3 {
		return nil, fmt.Errorf("expected 3 values, got %d", len(vals))
	}
	ciphertext := vals[2].([]byte)
	return map[string]any{
		"requester":       vals[0].(common.Address).Hex(),
		"roundId":         vals[1].(*big.Int).String(),
		"ciphertextBytes": len(ciphertext),
		"ciphertext":      "0x" + hex.EncodeToString(ciphertext),
		"description":     "ECIES ciphertext, decryptable only by the requester",
	}, nil
}
