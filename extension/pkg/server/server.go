// Package server starts the Fidensur extension's HTTP listener.
package server

import "fidensur-extension/internal/engine"

// StartExtension builds the engine and serves it in a goroutine.
//
// Returns a buffered error channel carrying any ListenAndServe failure. Buffered so a bind failure
// is not lost if nobody is reading yet — a silently unbound extension would be diagnosed as a TEE
// routing problem, which is a bad afternoon.
func StartExtension(extensionPort, signPort int) <-chan error {
	e := engine.New(extensionPort, signPort)

	errCh := make(chan error, 1)
	go func() {
		if err := e.Server.ListenAndServe(); err != nil {
			errCh <- err
		}
	}()
	return errCh
}
