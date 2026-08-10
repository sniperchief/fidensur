// Command register-extension registers a deployed Fidensur contract as an FCC extension.
//
// This is step 2 of the deployment lifecycle, after `forge create` deploys Fidensur.sol and before
// the Docker stack starts. It does what the Flare scaffold's tool of the same name does, using the
// same official bindings from go-flare-common, and writes the resulting extension ID to
// config/extension.env for the rest of the pipeline to read.
//
// Three on-chain steps, in order:
//
//  1. ExtensionManager.Register(stateVerifier, instructionSender) — binds the extension to exactly
//     one sender address. That binding is Fidensur's authorization boundary: the registry rejects
//     sendInstructions from anything else, which is why the enclave can trust the requester field
//     the contract stamps into a disclosure payload.
//  2. OwnerAllowlist.AddAllowedTeeMachineOwners — permits this deployer to register TEE machines
//     for the extension. Without it, post-build's register-tee reverts.
//  3. Fidensur.setExtensionId() — the contract discovers the ID it was assigned by scanning the
//     registry from 0x10000 upward.
//
// Usage:
//
//	go run ./tools/cmd/register-extension \
//	    -rpc https://coston2-api.flare.network/ext/C/rpc \
//	    -registry 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
//	    -sender 0xYourFidensurDeployment \
//	    -out ../config/extension.env
//
// The deployer key is read from DEPLOYMENT_PRIVATE_KEY, never from a flag — a key in argv ends up
// in shell history and in the process table.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"math/big"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/flare-foundation/go-flare-common/pkg/contracts/tee/extensionmanager"
	"github.com/flare-foundation/go-flare-common/pkg/contracts/tee/ownerallowlist"
)

// firstPublicExtensionID is 0x10000. The registry reserves everything below it for system
// extensions, and the contract's own scan starts here — so this scan must too.
const firstPublicExtensionID = 0x10000

func main() {
	var (
		rpcURL      = flag.String("rpc", "https://coston2-api.flare.network/ext/C/rpc", "chain RPC endpoint")
		registryHex = flag.String("registry", "", "FlareTeeManager diamond address (required)")
		senderHex   = flag.String("sender", "", "deployed Fidensur contract address (required)")
		verifierHex = flag.String("state-verifier", "", "state verifier address (defaults to the zero address)")
		outPath     = flag.String("out", "config/extension.env", "file to write EXTENSION_ID and INSTRUCTION_SENDER to")
		timeout     = flag.Duration("timeout", 5*time.Minute, "overall timeout")
	)
	flag.Parse()

	if *registryHex == "" || *senderHex == "" {
		flag.Usage()
		log.Fatal("both -registry and -sender are required")
	}
	if !common.IsHexAddress(*registryHex) {
		log.Fatalf("-registry is not an address: %s", *registryHex)
	}
	if !common.IsHexAddress(*senderHex) {
		log.Fatalf("-sender is not an address: %s", *senderHex)
	}

	keyHex := strings.TrimPrefix(strings.TrimSpace(os.Getenv("DEPLOYMENT_PRIVATE_KEY")), "0x")
	if keyHex == "" {
		log.Fatal("DEPLOYMENT_PRIVATE_KEY is not set")
	}
	key, err := crypto.HexToECDSA(keyHex)
	if err != nil {
		log.Fatalf("DEPLOYMENT_PRIVATE_KEY is not a valid private key: %v", err)
	}
	deployer := crypto.PubkeyToAddress(key.PublicKey)

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	client, err := ethclient.DialContext(ctx, *rpcURL)
	if err != nil {
		log.Fatalf("connecting to %s: %v", *rpcURL, err)
	}
	defer client.Close()

	chainID, err := client.ChainID(ctx)
	if err != nil {
		log.Fatalf("reading chain id: %v", err)
	}

	registry := common.HexToAddress(*registryHex)
	sender := common.HexToAddress(*senderHex)

	// The state verifier is optional: Fidensur verifies TEE results in its own contract rather than
	// delegating to a separate verifier, so the zero address is correct here.
	stateVerifier := common.Address{}
	if *verifierHex != "" {
		if !common.IsHexAddress(*verifierHex) {
			log.Fatalf("-state-verifier is not an address: %s", *verifierHex)
		}
		stateVerifier = common.HexToAddress(*verifierHex)
	}

	// Guard against a mistyped address that happens to be an EOA: registering a sender with no code
	// produces an extension that can never send an instruction, and the failure surfaces much later.
	code, err := client.CodeAt(ctx, sender, nil)
	if err != nil {
		log.Fatalf("reading code at %s: %v", sender.Hex(), err)
	}
	if len(code) == 0 {
		log.Fatalf("no contract deployed at %s — deploy Fidensur.sol first", sender.Hex())
	}

	log.Printf("chain id:          %s", chainID)
	log.Printf("deployer:          %s", deployer.Hex())
	log.Printf("registry (diamond): %s", registry.Hex())
	log.Printf("instruction sender: %s", sender.Hex())

	opts, err := bind.NewKeyedTransactorWithChainID(key, chainID)
	if err != nil {
		log.Fatalf("building transactor: %v", err)
	}
	opts.Context = ctx

	// Registration is not idempotent: calling it twice for the same sender produces two valid
	// extension IDs, both bound to the same contract. setExtensionId() then caches the *lowest*
	// one, permanently, while a second run of this tool would report the highest — and the
	// resulting config mismatch surfaces much later as MachineManager.TooMany(), a long way from
	// its cause. So look before registering.
	existing, err := findExistingRegistration(ctx, client, registry, sender)
	if err != nil {
		log.Fatalf("scanning for an existing registration: %v", err)
	}

	var extensionID *big.Int
	if existing != nil {
		log.Printf("this sender is ALREADY registered as extension ID %s (0x%x)", existing, existing)
		log.Printf("reusing it instead of registering again — a second registration would be an")
		log.Printf("orphan, since setExtensionId() caches the lowest matching ID permanently")
		extensionID = existing
	} else {
		extensionID, err = registerExtension(ctx, client, registry, opts, stateVerifier, sender)
		if err != nil {
			log.Fatalf("registering extension: %v", err)
		}
		log.Printf("registered with extension ID %s (0x%x)", extensionID, extensionID)
	}

	if err := allowMachineOwner(ctx, client, registry, opts, extensionID, deployer); err != nil {
		log.Fatalf("allowing TEE machine owner: %v", err)
	}
	log.Printf("deployer allowed as a TEE machine owner")

	if err := writeEnv(*outPath, extensionID, sender); err != nil {
		log.Fatalf("writing %s: %v", *outPath, err)
	}
	log.Printf("wrote %s", *outPath)

	log.Printf("")
	log.Printf("Next: call setExtensionId() on the Fidensur contract, then start the Docker stack.")
	log.Printf("  cast send %s 'setExtensionId()' --rpc-url %s --private-key $DEPLOYMENT_PRIVATE_KEY",
		sender.Hex(), *rpcURL)
}

// findExistingRegistration returns the lowest extension ID already bound to `sender`, or nil.
//
// Deliberately mirrors the contract's own scan in setExtensionId(): start at the first public ID
// and return the *first* match. Matching that order is the point — the contract caches whatever it
// finds first and can never change it, so any other answer here would disagree with the contract.
func findExistingRegistration(
	ctx context.Context,
	client *ethclient.Client,
	registry common.Address,
	sender common.Address,
) (*big.Int, error) {
	manager, err := extensionmanager.NewExtensionManager(registry, client)
	if err != nil {
		return nil, fmt.Errorf("binding ExtensionManager: %w", err)
	}

	callOpts := &bind.CallOpts{Context: ctx}
	next, err := manager.NextPublicExtensionId(callOpts)
	if err != nil {
		return nil, fmt.Errorf("reading nextPublicExtensionId: %w", err)
	}

	// Public extension IDs start at 0x10000; everything below is reserved for system extensions,
	// so scanning from zero would burn 65,536 calls and find nothing.
	for i := new(big.Int).SetUint64(firstPublicExtensionID); i.Cmp(next) < 0; i.Add(i, big.NewInt(1)) {
		owner, err := manager.GetTeeExtensionInstructionsSender(callOpts, i)
		if err != nil {
			return nil, fmt.Errorf("reading sender for extension %s: %w", i, err)
		}
		if owner == sender {
			return new(big.Int).Set(i), nil
		}
	}
	return nil, nil
}

// registerExtension calls ExtensionManager.Register and reads the assigned ID from the event.
func registerExtension(
	ctx context.Context,
	client *ethclient.Client,
	registry common.Address,
	opts *bind.TransactOpts,
	stateVerifier, sender common.Address,
) (*big.Int, error) {
	manager, err := extensionmanager.NewExtensionManager(registry, client)
	if err != nil {
		return nil, fmt.Errorf("binding ExtensionManager: %w", err)
	}

	tx, err := manager.Register(opts, stateVerifier, sender)
	if err != nil {
		return nil, fmt.Errorf("Register: %w", err)
	}

	receipt, err := bind.WaitMined(ctx, client, tx)
	if err != nil {
		return nil, fmt.Errorf("waiting for Register: %w", err)
	}
	if receipt.Status != 1 {
		return nil, fmt.Errorf("Register reverted (tx %s)", tx.Hash().Hex())
	}

	// Scan for the event rather than indexing a fixed log position: the registry sits behind a
	// diamond proxy, and assuming logs[0] breaks whenever the facet emits anything beforehand.
	for _, l := range receipt.Logs {
		ev, err := manager.ParseTeeExtensionRegistered(*l)
		if err != nil {
			continue
		}
		if ev.ExtensionId == nil || ev.ExtensionId.Sign() == 0 {
			// setExtensionId() treats zero as "unset", so a zero ID would make the contract
			// permanently unable to send instructions.
			return nil, fmt.Errorf("registry returned extension ID 0, which setExtensionId() cannot represent")
		}
		return ev.ExtensionId, nil
	}

	return nil, fmt.Errorf("no TeeExtensionRegistered event in tx %s", tx.Hash().Hex())
}

// allowMachineOwner permits the deployer to register TEE machines for this extension.
func allowMachineOwner(
	ctx context.Context,
	client *ethclient.Client,
	registry common.Address,
	opts *bind.TransactOpts,
	extensionID *big.Int,
	owner common.Address,
) error {
	allowlist, err := ownerallowlist.NewOwnerAllowlist(registry, client)
	if err != nil {
		return fmt.Errorf("binding OwnerAllowlist: %w", err)
	}

	callOpts := &bind.CallOpts{From: owner, Context: ctx}
	already, err := allowlist.IsAllowedTeeMachineOwner(callOpts, extensionID, owner)
	if err != nil {
		return fmt.Errorf("checking machine-owner status: %w", err)
	}
	if already {
		log.Printf("deployer is already an allowed TEE machine owner, skipping")
		return nil
	}

	tx, err := allowlist.AddAllowedTeeMachineOwners(opts, extensionID, []common.Address{owner})
	if err != nil {
		return fmt.Errorf("AddAllowedTeeMachineOwners: %w", err)
	}

	receipt, err := bind.WaitMined(ctx, client, tx)
	if err != nil {
		return fmt.Errorf("waiting for AddAllowedTeeMachineOwners: %w", err)
	}
	if receipt.Status != 1 {
		return fmt.Errorf("AddAllowedTeeMachineOwners reverted (tx %s)", tx.Hash().Hex())
	}
	return nil
}

// writeEnv records the values the rest of the pipeline reads.
//
// EXTENSION_ID must be a 32-byte hex string, not a decimal number. tee-node strips an optional 0x,
// hex-decodes the rest, and requires exactly 32 bytes:
//
//	valueStr, _ = strings.CutPrefix(valueStr, "0x")
//	valueB, err := hex.DecodeString(valueStr)
//	if len(extIDB) != 32 { ... }
//
// Writing the decimal form produced "invalid hex in environment variable EXTENSION_ID:
// encoding/hex: odd length hex string" — because "65818" is five characters. The node then failed
// to initialise while the extension's own HTTP server started anyway, so the container looked
// healthy and served nothing.
//
// FIDENSUR_CONTRACT is written alongside INSTRUCTION_SENDER because the engine reads it directly
// and refuses to start without knowing which deployment it serves.
func writeEnv(path string, extensionID *big.Int, sender common.Address) error {
	content := fmt.Sprintf(
		"# Generated by register-extension. Do not edit by hand.\n"+
			"#\n"+
			"# EXTENSION_ID is 32-byte hex because that is what tee-node parses. The decimal value\n"+
			"# is %s, shown here only for readability against block explorers.\n"+
			"EXTENSION_ID=%s\n"+
			"INSTRUCTION_SENDER=%s\n"+
			"FIDENSUR_CONTRACT=%s\n",
		extensionID,
		extensionIDHex(extensionID),
		sender.Hex(),
		sender.Hex(),
	)
	return os.WriteFile(path, []byte(content), 0o600)
}

// extensionIDHex renders an extension ID as the 0x-prefixed 32-byte hex string tee-node requires.
func extensionIDHex(extensionID *big.Int) string {
	return "0x" + common.Bytes2Hex(common.LeftPadBytes(extensionID.Bytes(), 32))
}
