// Package decoder turns raw instruction and result bytes into structured values for the types
// server.
//
// The registry is keyed by (OPType, OPCommand, Kind) with a wildcard fallback on an empty
// OPCommand, matching the dispatch rule in the FCC container contract §5.
package decoder

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/flare-foundation/go-flare-common/pkg/tee/structs"
)

// DataKind distinguishes a request payload from a response payload.
type DataKind string

const (
	KindMessage DataKind = "message"
	KindResult  DataKind = "result"
)

// Decoder turns raw bytes into something JSON-serializable.
type Decoder interface {
	Decode(data []byte) (any, error)
}

// RegistryKey identifies a decoder.
type RegistryKey struct {
	OPType    string   `json:"opType"`
	OPCommand string   `json:"opCommand"`
	Kind      DataKind `json:"kind"`
}

// Registry is a concurrency-safe map of decoders.
type Registry struct {
	mu       sync.RWMutex
	decoders map[RegistryKey]Decoder
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{decoders: make(map[RegistryKey]Decoder)}
}

// Register adds a decoder, replacing any existing entry for the key.
func (r *Registry) Register(key RegistryKey, dec Decoder) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.decoders[key] = dec
}

// Lookup resolves a decoder: exact match first, then the (OPType, "", Kind) wildcard.
func (r *Registry) Lookup(opType, opCommand string, kind DataKind) (Decoder, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if dec, ok := r.decoders[RegistryKey{OPType: opType, OPCommand: opCommand, Kind: kind}]; ok {
		return dec, nil
	}
	if dec, ok := r.decoders[RegistryKey{OPType: opType, OPCommand: "", Kind: kind}]; ok {
		return dec, nil
	}
	return nil, fmt.Errorf("no decoder registered for (%s, %s, %s)", opType, opCommand, kind)
}

// Keys lists every registered key, for GET /registry.
func (r *Registry) Keys() []RegistryKey {
	r.mu.RLock()
	defer r.mu.RUnlock()

	keys := make([]RegistryKey, 0, len(r.decoders))
	for k := range r.decoders {
		keys = append(keys, k)
	}
	return keys
}

// JSONDecoder decodes JSON bytes into T.
type JSONDecoder[T any] struct{}

// NewJSONDecoder returns a decoder for JSON payloads of type T.
func NewJSONDecoder[T any]() *JSONDecoder[T] {
	return &JSONDecoder[T]{}
}

func (d *JSONDecoder[T]) Decode(data []byte) (any, error) {
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, err
	}
	return v, nil
}

// ABIDecoder decodes ABI-encoded bytes into T using a declared argument layout.
type ABIDecoder[T any] struct {
	arg abi.Argument
}

// NewABIDecoder returns a decoder for ABI payloads matching arg.
func NewABIDecoder[T any](arg abi.Argument) *ABIDecoder[T] {
	return &ABIDecoder[T]{arg: arg}
}

func (d *ABIDecoder[T]) Decode(data []byte) (any, error) {
	return structs.Decode[T](d.arg, data)
}
