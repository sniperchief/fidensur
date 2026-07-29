package engine

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	"github.com/flare-foundation/tee-node/pkg/processorutils"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"fidensur-extension/internal/config"
)

// Boilerplate from the FCC extension scaffold, plus the async completion path.
//
// The one Fidensur-specific piece here is the COMPUTE deferral. Everything else follows the
// scaffold so a reader familiar with it finds what they expect.

// ActionResult status values, per the container contract §4.6.
const (
	statusError      uint8 = 0 // handler failed; log must be "error: <message>"
	statusSuccess    uint8 = 1 // handler succeeded; log must be "ok"
	statusInProgress uint8 = 2 // still running; log must be "pending"
)

// actionHandler serves POST /action.
//
// COMPUTE is deferred to a goroutine because tee-node's POST budget is ~2 seconds and an
// allocation over a real recipient set — decrypt, ABI-decode, evaluate, hash a Merkle tree —
// will exceed it. The handler acknowledges with status 2, then delivers the finished result to
// tee-node's /result endpoint, which signs it and forwards it to the proxy.
//
// DISCLOSE and ATTEST stay synchronous: both are a map lookup plus a hash or an encryption, well
// inside the budget, and a synchronous reply is simpler to reason about.
func (e *Engine) actionHandler(w http.ResponseWriter, r *http.Request) {
	var action teetypes.Action
	if err := json.NewDecoder(r.Body).Decode(&action); err != nil {
		http.Error(w, fmt.Sprintf("decoding action: %v", err), http.StatusBadRequest)
		return
	}

	logger.Infof("received action, ID: %s", action.Data.ID.Hex())

	if df, defer_ := shouldDefer(action); defer_ {
		go e.finishAsync(action)

		body, err := json.Marshal(inProgressResult(action, df))
		if err != nil {
			http.Error(w, fmt.Sprintf("encoding in-progress result: %v", err), http.StatusInternalServerError)
			return
		}
		logger.Infof("deferring action %s (COMPUTE exceeds the synchronous budget)", action.Data.ID.Hex())
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
		return
	}

	status, body := e.processAction(action)
	logger.Infof("sending action result, ID: %s, status: %d, log: %s",
		action.Data.ID.Hex(), status, logFromBody(body))

	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// shouldDefer reports whether an action must be handled asynchronously.
//
// Returns the parsed DataFixed alongside, so the caller can build the in-progress result without
// parsing twice. A payload that fails to parse is *not* deferred — it falls through to the
// synchronous path, which produces the proper 400.
func shouldDefer(action teetypes.Action) (*instruction.DataFixed, bool) {
	df, err := parseDataFixed(action)
	if err != nil {
		return nil, false
	}
	if df.OPType != teeutils.ToHash(config.OPTypeAlloc) {
		return df, false
	}
	return df, df.OPCommand == teeutils.ToHash(config.OPCommandCompute)
}

// finishAsync completes a deferred action and hands the result to tee-node for signing.
func (e *Engine) finishAsync(action teetypes.Action) {
	// A panic on this goroutine would take down the whole extension, and with it every other
	// round's confidential state. Contain it: one malformed policy must not be able to erase
	// the enclave's memory of every other.
	defer func() {
		if rec := recover(); rec != nil {
			logger.Errorf("async action %s panicked: %v", action.Data.ID.Hex(), rec)
		}
	}()

	status, body := e.processAction(action)
	if status != http.StatusOK {
		logger.Errorf("async action %s failed to route: %s", action.Data.ID.Hex(), string(body))
		return
	}

	var result teetypes.ActionResult
	if err := json.Unmarshal(body, &result); err != nil {
		logger.Errorf("async action %s: decoding own result: %v", action.Data.ID.Hex(), err)
		return
	}

	if err := postResultToNode(e.signPort, result); err != nil {
		logger.Errorf("async action %s: posting result: %v", action.Data.ID.Hex(), err)
		return
	}

	logger.Infof("async action %s posted to tee-node, status=%d", action.Data.ID.Hex(), result.Status)
}

// parseDataFixed extracts the instruction envelope from an action.
//
// ActionData.Message is doubly encoded: hex, then JSON. processorutils.Parse handles both.
func parseDataFixed(action teetypes.Action) (*instruction.DataFixed, error) {
	return processorutils.Parse[instruction.DataFixed](action.Data.Message)
}

// inProgressResult acknowledges a deferred action.
func inProgressResult(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	return teetypes.ActionResult{
		ID:            action.Data.ID,
		SubmissionTag: action.Data.SubmissionTag,
		Version:       config.Version,
		OPType:        df.OPType,
		OPCommand:     df.OPCommand,
		Status:        statusInProgress,
		Log:           "pending",
	}
}

// buildResult assembles an ActionResult.
//
// Version is a plain string here, while StateResponse.StateVersion is bytes32. The asymmetry is
// real and part of the container contract — the fce-sign Python and TypeScript ports both get it
// wrong, so it is worth not copying them.
//
// The log values are contractual, not cosmetic: status 0 requires "error: <message>", status 1
// requires "ok", anything else requires "pending".
func buildResult(
	action teetypes.Action,
	df *instruction.DataFixed,
	data []byte,
	status uint8,
	err error,
) teetypes.ActionResult {
	result := teetypes.ActionResult{
		ID:            action.Data.ID,
		SubmissionTag: action.Data.SubmissionTag,
		Version:       config.Version,
		OPType:        df.OPType,
		OPCommand:     df.OPCommand,
		Data:          data,
		Status:        status,
	}

	switch status {
	case statusError:
		result.Log = fmt.Sprintf("error: %v", err)
	case statusSuccess:
		result.Log = "ok"
	default:
		result.Log = "pending"
	}
	return result
}

// marshalResult serializes an ActionResult for the HTTP response.
//
// Always HTTP 200: a handler failure is signalled by ActionResult.Status, not by the HTTP status.
func marshalResult(result teetypes.ActionResult) (int, []byte) {
	body, err := json.Marshal(result)
	if err != nil {
		return http.StatusInternalServerError, []byte(fmt.Sprintf("encoding result: %v", err))
	}
	return http.StatusOK, body
}

// logFromBody pulls the log line out of a serialized result, for the access log.
func logFromBody(body []byte) string {
	var result teetypes.ActionResult
	if err := json.Unmarshal(body, &result); err != nil {
		return string(body)
	}
	return result.Log
}

// keccak is a thin alias, kept so the hashing used for the policy commitment is named at the call
// site and matches Solidity's keccak256 unambiguously.
func keccak(data []byte) []byte {
	return crypto.Keccak256(data)
}
