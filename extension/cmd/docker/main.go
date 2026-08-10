// Command docker is the container entrypoint: tee-node and the Fidensur extension in one process.
//
// The single-process topology is available only to Go, and it is why Fidensur is written in Go.
// Embedding tee-node as a library produces one static binary on a distroless base, which is what
// makes the image bit-for-bit reproducible across machines — and reproducibility is the whole basis
// of the public-verifiability claim. Every other language must run tee-node as a sibling process and
// settles for same-machine determinism.
package main

import (
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/flare-foundation/go-flare-common/pkg/logger"
	teeServer "github.com/flare-foundation/tee-node/pkg/server"

	"fidensur-extension/internal/config"
	extserver "fidensur-extension/pkg/server"
)

func main() {
	configPort := intEnv("CONFIG_PORT", 5501)
	signPort := config.SignPort
	extensionPort := config.ExtensionPort

	// Fail loudly on a missing contract address rather than serving in a permissive state. An
	// engine that cannot tell which deployment it serves cannot enforce the check that stops a
	// policy being replayed against a different Fidensur instance on the same TEE.
	if !config.ContractAddressSet {
		logger.Fatalf("FIDENSUR_CONTRACT is not set to a valid address; refusing to start")
	}

	logger.Infof("Fidensur allocation engine %s, serving contract %s",
		config.Version, config.ContractAddress.Hex())

	// tee-node in extension mode: attestation, the signing port, and /decrypt.
	//
	// StartServerExtension never returns while healthy — its final statement is an endless queue
	// loop. It returns only when node.Initialize fails, and even then it merely logs and returns
	// instead of exiting. Launched with a bare `go`, that leaves a dead goroutine while main blocks
	// on a signal forever: the extension's own HTTP server keeps answering, so the container stays
	// Up and `docker compose ps` reports healthy while nothing whatsoever is served.
	//
	// That is not hypothetical — a decimal EXTENSION_ID (tee-node requires 32-byte hex) produced
	// exactly this, and the deployment looked correct for hours. Treat any return as fatal, so the
	// container dies at the point of failure rather than lingering as a convincing impostor.
	teeCh := make(chan struct{})
	go func() {
		defer close(teeCh)
		teeServer.StartServerExtension(configPort, signPort, extensionPort)
	}()

	errCh := extserver.StartExtension(extensionPort, signPort)

	// Give the listener a moment to bind, then check for an immediate failure. Without this an
	// "address already in use" would surface much later as unexplained instruction timeouts.
	//
	// tee-node is checked here too, not only in the wait below, because node initialization fails
	// within milliseconds. Catching it now keeps the "extension running" line from being logged by
	// a process that cannot serve anything — that line is what made the failure look like a success.
	time.Sleep(100 * time.Millisecond)
	select {
	case err := <-errCh:
		logger.Fatalf("extension server failed to start: %v", err)
	case <-teeCh:
		logger.Fatalf("tee-node failed to start; see the error above — refusing to run without it")
	default:
	}

	logger.Infof("extension running (config=%d, sign=%d, extension=%d)", configPort, signPort, extensionPort)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	select {
	case <-sigCh:
		logger.Info("shutting down")
	case err := <-errCh:
		logger.Fatalf("extension server error: %v", err)
	case <-teeCh:
		// tee-node logs the actual cause itself before returning; look just above this line for
		// "node initialization failed".
		logger.Fatalf("tee-node stopped — the container cannot serve instructions; exiting")
	}
}

func intEnv(key string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v > 0 {
		return v
	}
	return fallback
}
