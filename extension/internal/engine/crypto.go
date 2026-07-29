package engine

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/crypto/ecies"

	"fidensur-extension/internal/config"
)

// Confidentiality in both directions.
//
// **Inbound** — the allocation policy arrives as ECIES ciphertext encrypted to the TEE's public
// key. Only tee-node holds the matching private key, so decryption must go through its local
// /decrypt endpoint. The key never enters this process.
//
// **Outbound** — a disclosure is encrypted to the *recipient's* public key. That needs no node
// assistance: encryption is a pure function of the recipient's public key, and go-ethereum's ecies
// package is already in the enclave. Only decryption requires a private key.
//
// The asymmetry matters for the threat model. The reply travels back through the public proxy in
// the clear, so anyone can read the bytes — but only the recipient can read the content. Publishing
// a disclosure leaks that someone asked, not what they were told.

type decryptRequest struct {
	// tee-node is Go, and Go marshals []byte as base64 in JSON. The wire encoding here is
	// therefore base64, not hex — the FCC container contract calls this "the single most common
	// porting mistake". Declaring the field as []byte gets it right automatically.
	EncryptedMessage []byte `json:"encryptedMessage"`
}

type decryptResponse struct {
	DecryptedMessage []byte `json:"decryptedMessage"`
}

// decryptViaNode asks the local tee-node to decrypt a payload encrypted to the TEE's public key.
func decryptViaNode(signPort int, ciphertext []byte) ([]byte, error) {
	if len(ciphertext) == 0 {
		return nil, fmt.Errorf("empty ciphertext")
	}

	body, err := json.Marshal(decryptRequest{EncryptedMessage: ciphertext})
	if err != nil {
		return nil, fmt.Errorf("marshal decrypt request: %w", err)
	}

	url := fmt.Sprintf("http://localhost:%d/decrypt", signPort)
	client := &http.Client{Timeout: config.HTTPTimeout}

	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("calling node /decrypt: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		// The node's message is echoed but the ciphertext is not, so a decrypt failure cannot be
		// turned into an oracle by reading the extension's logs.
		return nil, fmt.Errorf("node /decrypt returned %d: %s", resp.StatusCode, string(b))
	}

	var dr decryptResponse
	if err := json.NewDecoder(resp.Body).Decode(&dr); err != nil {
		return nil, fmt.Errorf("decode decrypt response: %w", err)
	}
	if len(dr.DecryptedMessage) == 0 {
		return nil, fmt.Errorf("node returned an empty plaintext")
	}
	return dr.DecryptedMessage, nil
}

// postResultToNode delivers a completed ActionResult to tee-node, which signs it and forwards it to
// the extension proxy.
//
// This is the second half of the async handler pattern: tee-node's POST /action call has a ~2s
// budget, too short for an allocation over a real recipient set, so the handler acknowledges
// immediately with status 2 and delivers the finished result here.
func postResultToNode(signPort int, result any) error {
	body, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("marshal action result: %w", err)
	}

	url := fmt.Sprintf("http://localhost:%d/result", signPort)
	client := &http.Client{Timeout: config.HTTPTimeout}

	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("posting result to node: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("node /result returned %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

// encryptToRecipient ECIES-encrypts plaintext to a recipient's secp256k1 public key.
//
// Accepts both encodings a wallet might produce: 65-byte uncompressed (0x04-prefixed) and 33-byte
// compressed (0x02/0x03-prefixed). Anything else is rejected rather than guessed at.
func encryptToRecipient(pubKeyBytes, plaintext []byte) ([]byte, error) {
	pub, err := parsePublicKey(pubKeyBytes)
	if err != nil {
		return nil, err
	}

	// nil s1/s2: no shared info. Matches go-ethereum's default ECIES parameters, which is what
	// tee-node and the frontend's lib/ecies.ts both use.
	ct, err := ecies.Encrypt(rand.Reader, ecies.ImportECDSAPublic(pub), plaintext, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("ecies encrypt: %w", err)
	}
	return ct, nil
}

// parsePublicKey decodes a secp256k1 public key in either supported form.
func parsePublicKey(b []byte) (*ecdsa.PublicKey, error) {
	switch len(b) {
	case 65:
		pub, err := crypto.UnmarshalPubkey(b)
		if err != nil {
			return nil, fmt.Errorf("invalid uncompressed public key: %w", err)
		}
		return pub, nil
	case 33:
		pub, err := crypto.DecompressPubkey(b)
		if err != nil {
			return nil, fmt.Errorf("invalid compressed public key: %w", err)
		}
		return pub, nil
	default:
		return nil, fmt.Errorf("public key must be 33 or 65 bytes, got %d", len(b))
	}
}
