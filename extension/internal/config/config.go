// Package config holds the extension's compile-time identity and its runtime configuration.
//
// The OPType/OPCommand constants below are one of three copies that must agree exactly; the others
// are in contracts/Fidensur.sol and extension/pkg/types/register.go. A mismatch produces a runtime
// 501 from the extension with no compile-time signal, which is why scripts/check-op-sync.sh diffs
// them in CI.
package config

import (
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

const (
	// Version identifies the allocation engine. It is reported in ActionResult.Version as a plain
	// string (not bytes32 — see docs/fcc-research.md §6.4) and, as bytes32, inside the signed
	// allocation result so a verifier can tell which engine produced a root.
	Version = "0.1.0"

	// Operation group. Must equal Fidensur.OP_TYPE_ALLOC.
	OPTypeAlloc = "ALLOC"

	// Commands. Must equal the matching Fidensur.OP_COMMAND_* constants.
	OPCommandCompute  = "COMPUTE"
	OPCommandDisclose = "DISCLOSE"
	OPCommandAttest   = "ATTEST"

	// TimeoutShutdown bounds graceful HTTP shutdown.
	TimeoutShutdown = 5 * time.Second

	// HTTPTimeout bounds calls to the local tee-node sign server.
	HTTPTimeout = 10 * time.Second
)

// MaxRecipients bounds the size of one allocation table.
//
// Two reasons for a ceiling. Enclave memory is finite and an unbounded recipient list is a
// denial-of-service vector against the TEE. And the Merkle proof a recipient later submits grows
// with log2(n), so an absurd table would make claims expensive. 4096 recipients is roughly a
// 12-element proof — comfortably cheap — and far beyond any realistic payroll.
const MaxRecipients = 4096

// Defaults, overridable by environment. The container contract fixes these port numbers; an
// extension implementation reads only these two, the rest are consumed by tee-node.
var (
	ExtensionPort = 7702
	SignPort      = 7701
)

// ContractAddress is the Fidensur deployment this engine will serve.
//
// Every instruction payload names its target contract, and the engine refuses any payload naming a
// different one. Without this check a policy encrypted for one deployment could be replayed against
// another sharing the same TEE — the on-chain commitment check would not catch it, because the
// commitment binds the ciphertext to a round, not to a contract.
//
// Empty means "unset", and the engine rejects every instruction rather than defaulting to
// permissive. A misconfigured deployment should fail loudly and immediately.
var ContractAddress common.Address

// ContractAddressSet reports whether FIDENSUR_CONTRACT was supplied.
var ContractAddressSet bool

func init() {
	if v, err := strconv.Atoi(os.Getenv("EXTENSION_PORT")); err == nil && v > 0 {
		ExtensionPort = v
	}
	if v, err := strconv.Atoi(os.Getenv("SIGN_PORT")); err == nil && v > 0 {
		SignPort = v
	}

	raw := strings.TrimSpace(os.Getenv("FIDENSUR_CONTRACT"))
	if common.IsHexAddress(raw) {
		ContractAddress = common.HexToAddress(raw)
		ContractAddressSet = true
	}
}
