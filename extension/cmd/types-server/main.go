// Command types-server renders raw Fidensur instruction and result bytes as readable JSON.
//
// It exists so the verification explorer can show what an instruction *is* without anyone having to
// hand-decode ABI in a browser. It decodes only what is already public: encrypted payloads are
// reported as shape — encrypted, length, hex — never unwrapped. It holds no keys and runs outside
// the enclave.
//
// Endpoints: POST /decode, GET /registry, GET /health. Default port 8100.
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	"fidensur-extension/internal/config"
	"fidensur-extension/pkg/decoder"
	"fidensur-extension/pkg/types"
)

type decodeRequest struct {
	OPType    string          `json:"opType"`
	OPCommand string          `json:"opCommand"`
	Kind      decoder.DataKind `json:"kind"`
	Data      string          `json:"data"` // 0x-prefixed hex
}

type decodeResponse struct {
	OPType    string           `json:"opType"`
	OPCommand string           `json:"opCommand"`
	Kind      decoder.DataKind `json:"kind"`
	Decoded   any              `json:"decoded"`
}

type errorResponse struct {
	Error string `json:"error"`
}

func main() {
	port := 8100
	if v, err := strconv.Atoi(os.Getenv("TYPES_SERVER_PORT")); err == nil && v > 0 {
		port = v
	}

	registry := decoder.NewRegistry()
	types.RegisterDecoders(registry)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /decode", decodeHandler(registry))
	mux.HandleFunc("GET /registry", registryHandler(registry))
	mux.HandleFunc("GET /health", healthHandler)

	addr := fmt.Sprintf(":%d", port)
	log.Printf("fidensur types-server %s listening on %s", config.Version, addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("types-server: %v", err)
	}
}

func decodeHandler(registry *decoder.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req decodeRequest
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("decoding request: %v", err))
			return
		}

		if req.Kind == "" {
			req.Kind = decoder.KindMessage
		}

		raw, err := hex.DecodeString(strings.TrimPrefix(req.Data, "0x"))
		if err != nil {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("data is not valid hex: %v", err))
			return
		}

		d, err := registry.Lookup(req.OPType, req.OPCommand, req.Kind)
		if err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}

		decoded, err := d.Decode(raw)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, fmt.Sprintf("decoding payload: %v", err))
			return
		}

		writeJSON(w, http.StatusOK, decodeResponse{
			OPType:    req.OPType,
			OPCommand: req.OPCommand,
			Kind:      req.Kind,
			Decoded:   decoded,
		})
	}
}

func registryHandler(registry *decoder.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"engineVersion": config.Version,
			"keys":          registry.Keys(),
		})
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"version": config.Version,
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	// The explorer is a static page served from elsewhere; this endpoint exposes only public data.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, errorResponse{Error: message})
}
