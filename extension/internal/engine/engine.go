// Package engine implements the Fidensur confidential allocation extension.
//
// It is an HTTP server that runs inside a Flare Confidential Compute TEE. tee-node delivers each
// on-chain instruction as POST /action; the engine decrypts the policy, evaluates it, and returns a
// result that the node signs with its attested key.
//
// The confidentiality boundary is this process. Recipient addresses, amounts, and allocation rules
// exist here in plaintext and nowhere else — not on-chain, not in the proxy, not in GET /state.
// What leaves is an aggregate (root, total, count) plus, per recipient, a payload encrypted to that
// recipient alone.
package engine

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	"github.com/flare-foundation/go-flare-common/pkg/tee/structs"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"fidensur-extension/internal/config"
	"fidensur-extension/pkg/types"
)

// ComputedRound is an evaluated allocation table, held in enclave memory.
//
// This is the confidential state. It never leaves the enclave whole: DISCLOSE reads one row and
// encrypts it to that row's recipient, ATTEST reads only the aggregate.
//
// Enclave memory is not durable — a TEE restart loses every round. That is survivable because
// COMPUTE is idempotent: re-submitting the same ciphertext reproduces the same table, indices, and
// root, bit for bit, and finalizeRound still accepts the result because the commitment is
// unchanged. Recovery is "re-run COMPUTE", which is why the organization must retain its ciphertext.
type ComputedRound struct {
	RoundID          *big.Int
	PolicyCommitment common.Hash
	Organization     common.Address
	Allocations      []Allocation
	Tree             *MerkleTree
	Root             common.Hash
	Total            *big.Int
	ComputedAt       int64

	// byRecipient indexes into Allocations. Read only for lookups — never iterated to produce
	// output, since Go randomizes map order.
	byRecipient map[common.Address]int
}

// Engine is the extension server and its confidential state.
type Engine struct {
	mu     sync.RWMutex
	Server *http.Server

	signPort int

	// rounds is keyed by policy commitment rather than round id. The commitment is what the chain
	// binds a result to, and it is what a DISCLOSE request carries, so keying on it means a
	// disclosure can never be served from a round that was recomputed under a different policy.
	rounds map[common.Hash]*ComputedRound

	stats types.State
}

// New builds the extension server.
//
// The HTTP surface is fixed by the FCC container contract: POST /action and GET /state, with
// 405 on the wrong method and 404 elsewhere. Go's ServeMux gives the method routing directly.
func New(extensionPort, signPort int) *Engine {
	e := &Engine{
		signPort: signPort,
		rounds:   make(map[common.Hash]*ComputedRound),
		stats: types.State{
			EngineVersion:   config.Version,
			ContractAddress: config.ContractAddress.Hex(),
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", e.stateHandler)
	mux.HandleFunc("POST /action", e.actionHandler)

	e.Server = &http.Server{
		Addr:    fmt.Sprintf(":%d", extensionPort),
		Handler: mux,
	}
	return e
}

// stateHandler serves GET /state.
//
// Aggregates only. Nothing here maps a round to a recipient, an amount, or a policy; a state
// endpoint that leaked those would undo the whole design. StateVersion is bytes32, unlike
// ActionResult.Version which is a plain string — the asymmetry is part of the container contract.
func (e *Engine) stateHandler(w http.ResponseWriter, r *http.Request) {
	e.mu.RLock()
	snapshot := e.stats
	snapshot.RoundsComputed = len(e.rounds)
	e.mu.RUnlock()

	resp := types.StateResponse{
		StateVersion: teeutils.ToHash(config.Version),
		State:        snapshot,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		http.Error(w, fmt.Sprintf("sending response: %v", err), http.StatusInternalServerError)
	}
}

// processAction routes an action on OPType, then on OPCommand.
//
// Returns an HTTP status and a body. Per the container contract, a handler that *fails* still
// returns 200 with an ActionResult carrying status 0 — the HTTP status describes routing, not
// outcome. Only an unroutable action gets 501.
func (e *Engine) processAction(action teetypes.Action) (int, []byte) {
	dataFixed, err := parseDataFixed(action)
	if err != nil {
		return http.StatusBadRequest, []byte(fmt.Sprintf("decoding fixed data: %v", err))
	}

	if dataFixed.OPType != teeutils.ToHash(config.OPTypeAlloc) {
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type: received %s, expected %s (%s)",
			dataFixed.OPType.Hex(), teeutils.ToHash(config.OPTypeAlloc).Hex(), config.OPTypeAlloc,
		))
	}

	switch dataFixed.OPCommand {
	case teeutils.ToHash(config.OPCommandCompute):
		// Reached only via the async path; see actionHandler.
		return marshalResult(e.processCompute(action, dataFixed))

	case teeutils.ToHash(config.OPCommandDisclose):
		return marshalResult(e.processDisclose(action, dataFixed))

	case teeutils.ToHash(config.OPCommandAttest):
		return marshalResult(e.processAttest(action, dataFixed))

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected one of [%s (%s), %s (%s), %s (%s)]",
			dataFixed.OPCommand.Hex(),
			teeutils.ToHash(config.OPCommandCompute).Hex(), config.OPCommandCompute,
			teeutils.ToHash(config.OPCommandDisclose).Hex(), config.OPCommandDisclose,
			teeutils.ToHash(config.OPCommandAttest).Hex(), config.OPCommandAttest,
		))
	}
}

// processCompute decrypts a policy, evaluates it, and returns the public aggregate.
//
// The four-step shape the FCC scaffold prescribes — decode, validate, execute, build — with
// decryption inserted between decode and validate, since the payload arrives as ciphertext.
//
// What comes back is an ABI-encoded tuple carrying the Merkle root, the total, and the recipient
// count. No address, no amount, no rule: everything a verifier needs and nothing that discloses.
func (e *Engine) processCompute(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	e.bump(func(s *types.State) { s.ComputeRequests++ })

	// 1. DECRYPT. The instruction payload is ECIES ciphertext; only tee-node holds the key.
	commitment := common.BytesToHash(keccak(df.OriginalMessage))

	plaintext, err := decryptViaNode(e.signPort, df.OriginalMessage)
	if err != nil {
		return e.fail(action, df, fmt.Errorf("decrypting policy: %w", err))
	}

	// 2. DECODE.
	var policy types.Policy
	if err := structs.DecodeTo(types.PolicyArg, plaintext, &policy); err != nil {
		return e.fail(action, df, fmt.Errorf("decoding policy: %w", err))
	}

	// 3. VALIDATE. Untrusted input, every field checked.
	if err := Validate(&policy); err != nil {
		return e.fail(action, df, fmt.Errorf("invalid policy: %w", err))
	}

	// 4. EXECUTE.
	allocations, err := Evaluate(&policy)
	if err != nil {
		return e.fail(action, df, fmt.Errorf("evaluating policy: %w", err))
	}

	leaves := make([]common.Hash, len(allocations))
	for i, a := range allocations {
		leaves[i] = LeafHash(policy.RoundId, a.Index, a.Recipient, a.Amount)
	}
	tree := BuildMerkleTree(leaves)
	if tree == nil {
		return e.fail(action, df, fmt.Errorf("internal: empty allocation table survived validation"))
	}

	total := SumAllocations(allocations)
	computed := &ComputedRound{
		RoundID:          new(big.Int).Set(policy.RoundId),
		PolicyCommitment: commitment,
		Organization:     policy.Organization,
		Allocations:      allocations,
		Tree:             tree,
		Root:             tree.Root(),
		Total:            total,
		ComputedAt:       time.Now().Unix(),
		byRecipient:      make(map[common.Address]int, len(allocations)),
	}
	for i, a := range allocations {
		computed.byRecipient[a.Recipient] = i
	}

	e.mu.Lock()
	// Idempotent by construction: recomputing the same ciphertext overwrites with an identical
	// table, so a retry after a lost result is safe.
	e.rounds[commitment] = computed
	e.stats.LastComputedAt = computed.ComputedAt
	e.mu.Unlock()

	logger.Infof("computed round %s: %d recipients, root %s",
		policy.RoundId, len(allocations), computed.Root.Hex())

	// 5. BUILD the public result.
	data, err := encodeAllocationResult(computed, uint32(len(allocations)))
	if err != nil {
		return e.fail(action, df, fmt.Errorf("encoding result: %w", err))
	}
	return buildResult(action, df, data, statusSuccess, nil)
}

// processDisclose returns one recipient's own allocation, encrypted to them.
//
// Two properties make this safe to serve over a public channel:
//
//   - The requester cannot be spoofed. Fidensur.sol stamps msg.sender into the payload, and the
//     registry admits instructions only from that one contract, so this field is authenticated
//     without the enclave verifying anything itself.
//   - The reply is public bytes with private content. It travels back through the proxy in the
//     clear as ECIES ciphertext under a key only the requester holds.
//
// A requester who is not in the table gets an explicit failure. Returning an empty success would be
// friendlier to a mistyped address and worse for everyone else — it would make the endpoint a
// membership oracle with a quieter signature.
func (e *Engine) processDisclose(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	e.bump(func(s *types.State) { s.DiscloseRequests++ })

	var req types.DiscloseRequest
	if err := structs.DecodeTo(types.DiscloseRequestArg, df.OriginalMessage, &req); err != nil {
		return e.fail(action, df, fmt.Errorf("decoding disclosure request: %w", err))
	}

	if !config.ContractAddressSet || req.ContractAddr != config.ContractAddress {
		return e.fail(action, df, fmt.Errorf("request targets contract %s, this engine serves %s",
			req.ContractAddr.Hex(), config.ContractAddress.Hex()))
	}
	if req.Requester == (common.Address{}) {
		return e.fail(action, df, fmt.Errorf("requester must not be the zero address"))
	}

	e.mu.RLock()
	round, ok := e.rounds[req.PolicyCommitment]
	e.mu.RUnlock()

	if !ok {
		// Either the round was never computed here, or the enclave restarted. Both are fixed by
		// re-running COMPUTE with the same ciphertext.
		return e.fail(action, df, fmt.Errorf(
			"no computed round for commitment %s; re-run COMPUTE", req.PolicyCommitment.Hex()))
	}
	if round.RoundID.Cmp(req.RoundId) != 0 {
		return e.fail(action, df, fmt.Errorf("commitment belongs to round %s, not %s",
			round.RoundID, req.RoundId))
	}

	idx, found := round.byRecipient[req.Requester]
	if !found {
		return e.fail(action, df, fmt.Errorf("requester has no allocation in this round"))
	}
	alloc := round.Allocations[idx]

	proof := round.Tree.Proof(idx)
	proofHex := make([]string, len(proof))
	for i, h := range proof {
		proofHex[i] = h.Hex()
	}

	disclosure := types.Disclosure{
		RoundId:    round.RoundID.String(),
		Index:      alloc.Index,
		Recipient:  alloc.Recipient.Hex(),
		Amount:     alloc.Amount.String(),
		Proof:      proofHex,
		MerkleRoot: round.Root.Hex(),
		TotalCount: uint32(len(round.Allocations)),
		EngineVer:  config.Version,
		ComputedAt: round.ComputedAt,
	}

	plaintext, err := json.Marshal(disclosure)
	if err != nil {
		return e.fail(action, df, fmt.Errorf("marshalling disclosure: %w", err))
	}

	ciphertext, err := encryptToRecipient(req.DisclosureKey, plaintext)
	if err != nil {
		return e.fail(action, df, fmt.Errorf("encrypting disclosure: %w", err))
	}

	data, err := types.DisclosureResultArgs.Pack(req.Requester, round.RoundID, ciphertext)
	if err != nil {
		return e.fail(action, df, fmt.Errorf("encoding disclosure result: %w", err))
	}

	logger.Infof("disclosed round %s entry to %s (%d proof elements)",
		round.RoundID, req.Requester.Hex(), len(proof))

	return buildResult(action, df, data, statusSuccess, nil)
}

// processAttest re-emits a computed round's signed integrity record.
//
// A signed result can be lost before it reaches the chain: the relay transaction can fail, the
// tunnel can drop. Recomputing is not free, so this returns the same aggregate from enclave state.
// The payload is byte-identical to what COMPUTE produced, so finalizeRound accepts it without
// caring which command generated it.
func (e *Engine) processAttest(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	e.bump(func(s *types.State) { s.AttestRequests++ })

	var req types.AttestRequest
	if err := structs.DecodeTo(types.AttestRequestArg, df.OriginalMessage, &req); err != nil {
		return e.fail(action, df, fmt.Errorf("decoding attestation request: %w", err))
	}

	if !config.ContractAddressSet || req.ContractAddr != config.ContractAddress {
		return e.fail(action, df, fmt.Errorf("request targets contract %s, this engine serves %s",
			req.ContractAddr.Hex(), config.ContractAddress.Hex()))
	}

	e.mu.RLock()
	round, ok := e.rounds[req.PolicyCommitment]
	e.mu.RUnlock()

	if !ok {
		return e.fail(action, df, fmt.Errorf(
			"no computed round for commitment %s; re-run COMPUTE", req.PolicyCommitment.Hex()))
	}
	if round.RoundID.Cmp(req.RoundId) != 0 {
		return e.fail(action, df, fmt.Errorf("commitment belongs to round %s, not %s",
			round.RoundID, req.RoundId))
	}

	// Self-check before re-signing: recompute the root from the stored leaves and confirm it still
	// matches. Cheap, and it turns a memory-corruption bug into a failed attestation rather than a
	// signature over a wrong root.
	if !e.rootIsIntact(round) {
		return e.fail(action, df, fmt.Errorf("internal: stored root does not match stored allocations"))
	}

	data, err := encodeAllocationResult(round, uint32(len(round.Allocations)))
	if err != nil {
		return e.fail(action, df, fmt.Errorf("encoding result: %w", err))
	}
	return buildResult(action, df, data, statusSuccess, nil)
}

// rootIsIntact rebuilds the tree from the stored allocations and compares roots.
func (e *Engine) rootIsIntact(round *ComputedRound) bool {
	leaves := make([]common.Hash, len(round.Allocations))
	for i, a := range round.Allocations {
		leaves[i] = LeafHash(round.RoundID, a.Index, a.Recipient, a.Amount)
	}
	tree := BuildMerkleTree(leaves)
	return tree != nil && tree.Root() == round.Root
}

// encodeAllocationResult packs the public aggregate exactly as Fidensur.finalizeRound decodes it.
func encodeAllocationResult(round *ComputedRound, recipientCount uint32) ([]byte, error) {
	return types.AllocationResultArgs.Pack(
		config.ContractAddress,
		round.RoundID,
		round.PolicyCommitment,
		round.Root,
		round.Total,
		recipientCount,
		teeutils.ToHash(config.Version),
	)
}

// fail records the failure and builds a status-0 result.
//
// The error text is returned to the caller, so it must never quote policy contents. Every error
// constructed above names a field or a condition, never a value from the plaintext.
func (e *Engine) fail(action teetypes.Action, df *instruction.DataFixed, err error) teetypes.ActionResult {
	e.bump(func(s *types.State) { s.FailedRequests++ })
	logger.Warnf("action %s failed: %v", action.Data.ID.Hex(), err)
	return buildResult(action, df, nil, statusError, err)
}

// bump applies a counter update under the write lock.
func (e *Engine) bump(fn func(*types.State)) {
	e.mu.Lock()
	fn(&e.stats)
	e.mu.Unlock()
}
