# Flare Confidential Compute (FCC) — Research Notes

**Project:** Fidensur
**Status:** Phase 1 — research complete, normative for all downstream design
**Research date:** 2026-07-28
**Primary sources:** [Flare Developer Hub](https://dev.flare.network/), the official
`flare-foundation` reference repositories (cloned and read at the commits listed in
[§13](#13-source-provenance)), and the normative
[Extension Container Contract](https://github.com/flare-foundation/fce-extension-scaffold/blob/main/docs/extension-contract.md).

> **Reading order.** [§1](#1-what-fcc-is) – [§3](#3-the-instruction-lifecycle) explain what FCC
> is and how a request travels. [§4](#4-on-chain-building-blocks) – [§7](#7-the-extension-container-contract-normative)
> are the parts Fidensur must implement exactly. [§8](#8-attestation-and-verification) is the
> foundation of Fidensur's public-verifiability claim. [§10](#10-known-limitations) – [§12](#12-assumptions-made)
> record what is *not* settled, and matter as much as the rest.

---

## 1. What FCC Is

Flare Confidential Compute lets a developer run custom code inside a hardware-isolated
**Trusted Execution Environment** and wire that code to Flare smart contracts. Flare's TEEs run
on **GCP Confidential Space** backed by **AMD SEV** memory encryption.

The unit of deployment is an **extension**: an HTTP server that runs inside the enclave, receives
instructions that originate from on-chain transactions, executes confidential logic, and returns a
result that the TEE node signs. The signature is verifiable on-chain with `ecrecover`.

FCC is worth using when an application needs **confidential state, secret-holding, or off-chain
computation whose integrity is provable on-chain** — sealed-bid auctions, private order matching,
key management, and (Fidensur's case) private allocation of a public treasury.

Three architectural layers, per the [FCC overview](https://dev.flare.network/fcc/overview):

| Layer | Role |
| --- | --- |
| **Smart contracts** | Govern compute extensions, TEE registration, and private-key administration |
| **Data providers & cosigners** | Relay instructions and authorize sensitive operations |
| **TEE machines** | Verify consensus thresholds, execute computation, sign results |

Each deployed extension consists of a **TEE Machine** (confidential, not publicly reachable) and a
**TEE Proxy** (public HTTP interface). Consensus for sensitive protocol operations requires >50%
signature weight across registered machines.

FCC is explicitly documented as **in the final stages of development, not yet a fully public
production system**. Extensions can nevertheless be built and deployed on Coston2 today. This is a
material constraint on Fidensur and is carried into [§10](#10-known-limitations).

---

## 2. Architecture Summary

```
        ON-CHAIN (Coston2 / Flare)              OFF-CHAIN INFRASTRUCTURE            ENCLAVE
┌────────────────────────────────┐     ┌──────────────────────────┐     ┌────────────────────┐
│  Your InstructionSender        │     │  ext-proxy               │     │  tee-node          │
│  (the ONLY registered caller)  │     │  - watches chain         │     │  - attestation     │
│            │                   │     │  - queues actions        │     │  - signing (:7701) │
│            ▼                   │     │  - submits results       │     │  - /decrypt        │
│  TeeExtensionRegistry          │◄───►│  - public API (:6664)    │◄───►│         │          │
│  .sendInstructions()           │     │  - internal API (:6663)  │     │         ▼          │
│            │                   │     └──────────────────────────┘     │  YOUR EXTENSION    │
│            ▼                   │                  │                   │  POST /action      │
│  emits TeeInstructionsSent     │                  ▼                   │  GET  /state       │
│                                │             ┌────────┐               │  (:7702)           │
│  TeeMachineRegistry            │             │ redis  │               └────────────────────┘
│  .getRandomTeeIds()            │             └────────┘                 GCP Confidential
└────────────────────────────────┘                                        Space / AMD SEV
```

A developer owns exactly **two** things in this picture: the **InstructionSender contract** and the
**extension's action handler**. Everything between them is Flare infrastructure and must not be
redesigned.

On Coston2 the protocol side is a **diamond**, `FlareTeeManager` at
`0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`, with facets including `ExtensionManagerFacet`,
`InstructionsFacet`, `MachineManagerFacet`, `VerificationFacet`, and `ExtensionGovernanceFacet`.
`ITeeExtensionRegistry` and `ITeeMachineRegistry` are the user-facing interfaces onto that diamond,
so both interface addresses are the same diamond address.

> **Consequence for Fidensur:** if the `FlareTeeManager` diamond is redeployed, *every* registration
> is wiped — extension IDs, code-hash allowlists, TEE machines. Recovery means re-running pre-build
> for a fresh `EXTENSION_ID`, restarting the VM with it, then post-build. Fidensur's deployment
> tooling must treat extension ID as a re-derivable value, never a hard-coded constant.

---

## 3. The Instruction Lifecycle

```
1. User calls your InstructionSender contract                          (on-chain, you own this)
2. Contract calls TeeExtensionRegistry.sendInstructions()
       → emits TeeInstructionsSent, returns bytes32 instructionId
3. TEE proxy picks up the instruction from the chain
4. TEE node fetches the instruction from the proxy
5. TEE node POSTs it to your extension as POST /action                 (inside the enclave)
6. Your extension decodes → validates → executes → returns ActionResult (you own this)
7. TEE node signs the result and returns it (optionally cosigned) to the proxy
8. Caller polls the proxy for the result
9. (optional) Anyone relays the signed result back on-chain, where a contract
   reconstructs the signed hash and ecrecovers the TEE address
```

Step 9 is not part of the base lifecycle but is the pattern `fce-weather-insurance` uses, and it is
**the single most important step for Fidensur** — it is what converts "the TEE said so" into
"the chain verified it".

### 3.1 Timing constraint — the 2-second POST budget

`tee-node`'s `POST /action` call to the extension has a **~2 second timeout**. A handler that needs
longer (a slow external API, a heavy computation over many recipients) must use the **async
pattern** that `fce-weather-insurance` demonstrates:

1. Return immediately with `status: 2` and `log: "action in processing"` (an *in-progress* result).
2. Continue the work on a goroutine.
3. When finished, POST the completed `ActionResult` to the node's
   **`http://localhost:$SIGN_PORT/result`** endpoint, which signs it and forwards it to the proxy.

Fidensur's allocation computation iterates over a recipient set and will exceed 2 seconds for any
realistic payroll, so **the async pattern is mandatory, not optional**, for the compute path.

---

## 4. On-Chain Building Blocks

### 4.1 `ITeeExtensionRegistry`

```solidity
interface ITeeExtensionRegistry {
    struct TeeInstructionParams {
        bytes32   opType;
        bytes32   opCommand;
        bytes     message;
        address[] cosigners;
        uint64    cosignersThreshold;
        address   claimBackAddress;
    }

    function sendInstructions(
        address[] calldata _teeIds,
        TeeInstructionParams calldata _instructionParams
    ) external payable returns (bytes32 _instructionId);

    function nextPublicExtensionId() external view returns (uint256);

    function getTeeExtensionInstructionsSender(uint256 _extensionId) external view returns (address);
}
```

**Access control is the load-bearing property.** Registration binds an extension to exactly **one**
InstructionSender address. The registry rejects any `sendInstructions` whose `msg.sender` is not that
address — not an EOA, not another contract. This is what lets Fidensur enforce authorization on-chain
before anything reaches the enclave.

`sendInstructions` is `payable`; the registry charges a per-instruction fee, so the sender contract
must be `payable` and forward `msg.value`.

### 4.2 `ITeeMachineRegistry`

```solidity
interface ITeeMachineRegistry {
    function getRandomTeeIds(uint256 _extensionId, uint256 _count)
        external view returns (address[] memory);
}
```

`_count > 1` fans one instruction out to multiple TEEs. Fidensur uses `_count = 1` for v1 and
records multi-TEE fan-out as a future hardening step ([§10](#10-known-limitations)).

### 4.3 Extension ID discovery

Public extension IDs start at **`0x10000` (65536)**; everything below is reserved for system
extensions. The canonical discovery routine — marked **DO NOT MODIFY** in the scaffold — scans
upward from `0x10000` and caches the result set-once:

```solidity
uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000;

function setExtensionId() external {
    require(_extensionId == 0, "Extension ID already set.");
    uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
    for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
        if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
            _extensionId = i;
            return;
        }
    }
    revert("Extension ID not found.");
}
```

Scanning from zero is a real and easy mistake; it wastes gas over 65536 reserved slots and finds
nothing. Fidensur reproduces this function verbatim.

### 4.4 InstructionSender requirements

A conforming InstructionSender must:

1. **Know its extension ID** — via `setExtensionId()`, called once after registration.
2. **Call `sendInstructions`** with ≥1 `teeId`, the `opType`/`opCommand` pair, a non-empty `message`,
   and (usually empty) cosigners.
3. **Be `payable` and forward `msg.value`.**
4. **Exist before registration** — registration takes the deployed address as its argument.

Beyond that the registry does not care what the contract does. Custom access control, on-chain
validation, batching, and multi-TEE routing are all fair game — which is exactly the latitude
Fidensur needs.

---

## 5. The OPType / OPCommand Routing Model

Two-level `bytes32` routing. `OPType` selects an operation group; `OPCommand` sub-routes within it.
The identifiers must match **exactly across three layers**:

| Layer | Operation type | Command |
| --- | --- | --- |
| Solidity | `bytes32 OP_TYPE_X = bytes32("X")` | `bytes32 OP_COMMAND_Y = bytes32("Y")` |
| Go config | `OPTypeX = "X"` | `OPCommandY = "Y"` |
| Go router | `df.OPType == teeutils.ToHash(config.OPTypeX)` | `df.OPCommand == teeutils.ToHash(config.OPCommandY)` |

Encoding: a `bytes32` identifier is the UTF-8 string **right-padded with zero bytes to 32 bytes**.
`"GREETING"` is 8 content bytes followed by 24 zero bytes. The cap is **31 bytes** of content —
identifiers must be short.

Dispatch resolution order:

1. Exact `(opType, opCommand)` match.
2. `(opType, <empty bytes32>)` as a **wildcard default** for every command under that op-type.
3. No match → HTTP **501**.

A mismatched `OPType` produces "unsupported op type"; a mismatched `OPCommand` produces "unsupported
op command". Both are silent-until-runtime failures, which is why the three-layer table above is
worth keeping in one place per project.

---

## 6. Request and Response Flow (wire format)

All encodings below are derived from the Go types `tee-node` actually serializes. Getting these
wrong fails **silently** — the node accepts the request and verification breaks later.

| Go type | JSON encoding |
| --- | --- |
| `common.Hash` | `"0x"` + 64 lowercase hex chars, always full width |
| `common.Address` | `"0x"` + 40 hex chars |
| `hexutil.Bytes` | `"0x"` + hex, variable length; empty encodes as `"0x"` — **not** `null`, **not** `""` |
| `uint8`/`uint32`/`uint64` | JSON number |
| `string` | JSON string |

### 6.1 `Action` — body of `POST /action`

| Field | Type | Notes |
| --- | --- | --- |
| `data` | `ActionData` | §6.2 |
| `additionalVariableMessages` | `[]hexutil.Bytes` | |
| `timestamps` | `[]uint64` | |
| `additionalActionData` | `hexutil.Bytes` | |
| `signatures` | `[]hexutil.Bytes` | |

### 6.2 `ActionData`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `common.Hash` | echoed back in the result |
| `type` | string | `"instruction"` or `"direct"` |
| `submissionTag` | string | `"threshold"`, `"end"`, or `"submit"`; echoed back |
| `message` | `hexutil.Bytes` | **hex-encoded UTF-8 JSON** that decodes to a `DataFixed` |

Note the **double encoding** on `message`: hex-decode first, then parse the bytes as JSON.

### 6.3 `DataFixed` — decoded from `ActionData.message`

| Field | Type | Notes |
| --- | --- | --- |
| `instructionId` | `common.Hash` | |
| `teeId` | `common.Address` | |
| `timestamp` | `uint64` | |
| `rewardEpochId` | `uint32` | |
| `opType` | `common.Hash` | bytes32 of the op-type string |
| `opCommand` | `common.Hash` | bytes32 of the op-command string |
| `cosigners` | `[]common.Address` | |
| `cosignersThreshold` | `uint64` | |
| `originalMessage` | `hexutil.Bytes` | **your payload** — the bytes the contract passed to `sendInstructions` |
| `additionalFixedMessage` | `hexutil.Bytes` | |

`originalMessage` interpretation is entirely the extension's choice — JSON, ABI, or ciphertext. The
scaffold shows JSON (`SAY_HELLO`) and ABI (`SAY_GOODBYE`); weather-insurance shows ECIES ciphertext
(`BUY`). **It is untrusted external input and must be strictly validated.**

### 6.4 `ActionResult` — response body

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `common.Hash` | echo `action.data.id` |
| `submissionTag` | string | echo `action.data.submissionTag` |
| `status` | `uint8` | §6.5 |
| `log` | string | §6.5 |
| `opType` | `common.Hash` | echo from `DataFixed` |
| `opCommand` | `common.Hash` | echo from `DataFixed` |
| `additionalResultStatus` | `hexutil.Bytes` | `"0x"` when unused |
| `version` | **plain `string`** | see the trap below |
| `data` | `hexutil.Bytes` | your response payload; `"0x"` when none |

Two traps worth stating explicitly:

> **`version` is a plain string, not bytes32.** Send `"0.1.0"`, not `"0x302e312e30000…"`. This is
> asymmetric with `StateResponse.stateVersion`, which **is** bytes32. The `fce-sign` Python and
> TypeScript ports both get this wrong; the conformance fixtures in
> `testdata/conformance/` pin the correct encoding.

> **`data` must be byte-exact.** `ActionResult.Hash()` computes `keccak256(data)` and *that hash is
> signed*. Emit compact JSON with no whitespace, preserving field declaration order. Any
> serialization drift breaks on-chain verification.

Every field is **always present** — the Go struct carries no `omitempty`, so empty `hexutil.Bytes`
marshals as `"0x"` rather than being omitted.

### 6.5 `status` and `log`

| `status` | Meaning | Required `log` |
| --- | --- | --- |
| `0` | Handler failed | `"error: <message>"` |
| `1` | Handler succeeded | `"ok"` |
| anything else | In progress | `"pending"` |

`data` is only meaningful for `status == 1`. On-chain verifiers must **require `status == 1`**, or a
failed result becomes relayable.

---

## 7. The Extension Container Contract (normative)

Any container satisfying `docs/extension-contract.md` is a valid FCC extension regardless of
language. Fidensur targets **Go**, which allows the single-process topology (extension embeds
`tee-node` as a library) and is the only language with **bit-for-bit cross-machine reproducible
builds**.

### 7.1 HTTP surface the extension MUST serve

On `$EXTENSION_PORT`, bound on all interfaces inside the container:

| Request | Condition | HTTP status | Body |
| --- | --- | --- | --- |
| `POST /action` | Routed to a handler (success **or** handler error) | 200 | `ActionResult` JSON |
| `POST /action` | Body is not valid JSON | 400 | error text |
| `POST /action` | `data.message` is not valid hex | 400 | error text |
| `POST /action` | `data.message` does not decode to `DataFixed` | 400 | error text |
| `POST /action` | No handler for `(opType, opCommand)` | 501 | text containing `unsupported op type` |
| `GET /state` | — | 200 | `StateResponse` JSON |
| `GET /action` | — | 405 | |
| `POST /state` | — | 405 | |
| any other path | — | 404 | |

**Handler failure is signalled by `ActionResult.status`, never by the HTTP status.** A handler that
rejects bad input still returns HTTP 200 with `status: 0`.

**Concurrency:** handler invocations are serialized — at most one runs at a time, and `GET /state` is
serialized against handlers too, so a state read never observes a half-applied mutation.

### 7.2 HTTP surface the extension MAY call

`tee-node` exposes a signing/crypto API on `http://localhost:$SIGN_PORT`, never exposed outside the
container.

**`POST /decrypt`** — decrypts a payload encrypted to the TEE's public key.

```json
Request:  { "encryptedMessage": "<base64>" }
Response: { "decryptedMessage": "<base64>" }
```

> **Encoding trap.** The wire encoding here is **base64, not hex**, because Go marshals `[]byte` as
> base64 in JSON. The contract document calls this "the single most common porting mistake."

**`POST /result`** — accepts a completed `ActionResult` for the async pattern ([§3.1](#31-timing-constraint--the-2-second-post-budget)); the node signs
it and forwards it to the proxy.

### 7.3 Container requirements

Environment variables consumed (the extension itself only needs `EXTENSION_PORT` and `SIGN_PORT`;
the rest are for `tee-node`, but all must be *settable*):

`MODE`, `CONFIG_PORT` (5501), `SIGN_PORT` (7701), `EXTENSION_PORT` (7702), `PROXY_URL`, `CHAIN_ID`,
`LOG_LEVEL`, `INITIAL_OWNER`, `GOVERNANCE_SIGNERS`, `GOVERNANCE_THRESHOLD`.

```dockerfile
EXPOSE 5501 7701 7702
USER 0:0
LABEL "tee.launch_policy.allow_env_override"="LOG_LEVEL,PROXY_URL,INITIAL_OWNER,EXTENSION_ID,CHAIN_URL,MODE,CONFIG_PORT,SIGN_PORT,EXTENSION_PORT"
```

> **The launch-policy label is mandatory.** Without it a GCP Confidential Space VM **rejects operator
> env overrides at attestation time**, and whatever was baked into the image at build is final. The
> failure surfaces at attestation, not at build — one of the nastier failure modes in the system.

`USER 0:0` matches `tee-node`: the TEE is the isolation boundary, not in-container user separation.

### 7.4 The 4-step handler pattern

Every handler follows the same shape. This is the pattern Fidensur's handlers follow:

```go
func (e *Extension) processX(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
    // 1. DECODE the raw OriginalMessage (JSON, ABI via structs.DecodeTo, or ciphertext)
    var req types.XRequest
    dec := json.NewDecoder(bytes.NewReader(df.OriginalMessage))
    dec.DisallowUnknownFields()
    if err := dec.Decode(&req); err != nil {
        return buildResult(action, df, nil, 0, fmt.Errorf("decoding request: %w", err))
    }

    // 2. VALIDATE every field — this is untrusted external input
    if req.Field == "" {
        return buildResult(action, df, nil, 0, fmt.Errorf("field must not be empty"))
    }

    // 3. EXECUTE confidential logic (guard shared state with the mutex)
    e.mu.Lock()
    // ...
    e.mu.Unlock()

    // 4. BUILD the result: status 1 = success, status 0 = error
    data, _ := json.Marshal(types.XResponse{ /* ... */ })
    return buildResult(action, df, data, 1, nil)
}
```

`dec.DisallowUnknownFields()` is a small but real defence: it rejects payloads carrying fields the
handler does not model.

### 7.5 Files a developer modifies

The scaffold marks these ★; everything else is boilerplate:

1. `internal/config/config.go` — `OPType`/`OPCommand` constants and version
2. `pkg/types/types.go` — request/response/state structs
3. `internal/extension/extension.go` — routing cases and handlers (the main customization point)
4. `pkg/types/register.go` — decoder registrations for the types server
5. `contracts/InstructionSender.sol` — matching `bytes32` constants and send functions
6. `tools/cmd/run-test/main.go` — end-to-end test payloads and assertions

`New()`, `actionHandler()`, `buildResult()`, the constructor, `setExtensionId()`, and
`_getExtensionId()` are explicitly **DO NOT MODIFY**.

### 7.6 Types server

A lightweight HTTP sidecar that turns raw hex instruction data into human-readable JSON for
frontends and debugging.

- Endpoints: `POST /decode`, `GET /registry`, `GET /health`; default port **8100**.
- Register one decoder per `(OPType, OPCommand, Kind)` in `pkg/types/register.go`, where `Kind` is
  `message` (request) or `result` (response).
- Helpers: `NewJSONDecoder[T]()` and `NewABIDecoder[T](abiArgument)`.
- `Lookup` matches `(OPType, OPCommand, Kind)` exactly, then falls back to `(OPType, "", Kind)`.

Fidensur uses this for its public verification UI: it lets the explorer render *shapes* and
*metadata* of confidential instructions without revealing plaintext. Weather-insurance shows the
right idiom for confidential payloads — an `encryptedMessageDecoder` that returns
`{encrypted: true, length: N, hex: "0x…"}` rather than attempting to decode.

---

## 8. Attestation and Verification

This section is the technical basis for Fidensur's tagline, *"Prove the computation publicly."*

### 8.1 Attestation

The TEE's trust comes from **remote attestation**. The Confidential Space VM measures the running
image and reports a **code hash**. Flare's data providers (FTDC) accept results only from a TEE
whose code hash has been **whitelisted on-chain** for that extension.

The chain of trust is therefore:

```
published source  →(reproducible build)→  image  →(measurement)→  code hash
   →(allow-tee-version, on-chain)→  whitelisted  →(attestation)→  registered TEE machine
   →(signing key)→  TEE address  →(ecrecover on-chain)→  verified result
```

Every link is publicly checkable. A verifier who can rebuild the published source and reproduce the
whitelisted code hash knows exactly what code produced a given signed result — without seeing any of
the confidential inputs.

| Setting | Meaning |
| --- | --- |
| `MODE=0` | Production attestation backend (FTDC-accepted) |
| `MODE=1` | **Simulated** attestation — FTDC rejects it on testnet/mainnet |
| `SIMULATED_TEE=true` + `MODE=1` | Valid local/dev pairing |
| `SIMULATED_TEE=false` + `MODE=0` | Required for real testnet/mainnet |
| Mismatched pair | Fails with `code hashes do not match` |

Verify a real deploy by curling the proxy's `/info` and checking `machineData`:

- `platform` starts with `0x4743505f414d445f534556…` (`GCP_AMD_SEV`)
- `codeHash` is a real measured hash, **not** the simulated `0x194844cf…`
- `extensionId` and `initialOwner` match `config/extension.env`

### 8.2 Reproducible builds

Because the code hash is what gets registered on-chain, build determinism is a **security property**.
Every language image must:

- accept and propagate a `SOURCE_DATE_EPOCH` build arg (conventionally `git log -1 --format=%ct`),
- pin apt to `snapshot.debian.org` keyed on `SOURCE_DATE_EPOCH`,
- install dependencies from a committed lockfile (`go.sum`, `package-lock.json`, pinned `requirements.txt`),
- normalize mtimes as the final build step: `RUN find /app -exec touch -h -d @${SOURCE_DATE_EPOCH} {} +`.

Determinism is **not equal across languages**:

| Language | Guarantee |
| --- | --- |
| **Go on distroless** | Bit-for-bit reproducible **across machines** |
| Python | Same-machine only — pip wheels embed host paths |
| TypeScript | Same-machine only — `node_modules` layout is npm-version dependent |

A rebuild on a different machine can change a Python/TS code hash and force re-registration. **This
is decisive for Fidensur: the extension is written in Go**, because a verification claim that only
holds on one machine is not a verification claim.

The Go build flags that make this work:

```dockerfile
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOFLAGS="-buildvcs=false" \
    go build -trimpath -ldflags="-buildid= -s -w" -o /app/extension-tee ./cmd/docker
```

`-trimpath` strips build-host paths, `-buildid=` clears Go's non-deterministic build id, `-s -w` drop
symbol and DWARF tables containing build-time data, `CGO_ENABLED=0` avoids link-time libc variance.
The base image is pinned **by digest**, not by tag.

A subtlety worth recording: BuildKit's `rewrite-timestamp` only clamps mtimes *downward*
([moby/buildkit#3180](https://github.com/moby/buildkit/issues/3180)), leaving files older than
`SOURCE_DATE_EPOCH` at nondeterministic mtimes — hence the explicit `touch` of every path.

### 8.3 On-chain verification of a TEE result

The `tee-node` signs a **domain-separated** payload, not the bare result hash. Getting this wrong is
the difference between a working verifier and one that silently rejects every signature.

```
resultHash  = keccak256(abi.encodePacked(
                  keccak256(resultData),
                  actionId,
                  keccak256(bytes(submissionTag)),
                  status))

payloadHash = keccak256(abi.encode(
                  bytes32("TEE_ACTION_RESULT"),
                  chainId,
                  resultHash))

signature   = ECDSA_sign(EIP191_personal_sign(payloadHash))   // "\x19Ethereum Signed Message:\n32"
```

The Solidity verifier:

```solidity
bytes32 private constant TEE_ACTION_RESULT_PREFIX = bytes32("TEE_ACTION_RESULT");

require(teeAddress != address(0), "TEE address not set");
require(_status == 1, "TEE reported failure");

bytes32 resultHash = keccak256(abi.encodePacked(
    keccak256(_resultData), _actionId, keccak256(bytes(_submissionTag)), _status));

bytes32 payloadHash = keccak256(abi.encode(
    TEE_ACTION_RESULT_PREFIX, block.chainid, resultHash));

address signer = _recover(_ethSigned(payloadHash), _signature);
require(signer == teeAddress, "bad TEE signature");
```

with

```solidity
function _ethSigned(bytes32 _hash) private pure returns (bytes32) {
    return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _hash));
}
```

Four properties this gives, all of which Fidensur depends on:

1. **`chainId` binding** — a signature from Coston2 cannot be replayed on Flare mainnet.
2. **`actionId` binding** — a result is bound to one specific FCC instruction and cannot be replayed
   against a different action.
3. **`status` binding** — a *failed* TEE result cannot be relayed as a success, because `status` is
   inside the signed hash.
4. **Signer binding** — only the registered `teeAddress` produces an accepted signature.

> **The trap:** verifying against the raw `resultHash` — omitting the
> `abi.encode(TEE_ACTION_RESULT, chainId, ·)` wrapper — fails against current TEE node signatures.
> This must match `go-flare-common`'s `signing.TEEActionResult` exactly.

`_resultData` is the **exact bytes** the TEE returned in `ActionResult.Data`. If the on-chain
verifier will `abi.decode` it, the extension must ABI-encode it (not JSON-encode it).

### 8.4 Confidential input — ECIES

For inputs that must never appear on-chain in plaintext, weather-insurance's `buyPolicyPrivate`
establishes the pattern Fidensur reuses for private allocation lists:

1. The client fetches the extension's TEE public key.
2. The client **ECIES-encrypts** ABI-encoded parameters to that key.
3. Only the **ciphertext** is sent on-chain as the instruction message.
4. The TEE decrypts via `POST localhost:$SIGN_PORT/decrypt` and holds plaintext **only in enclave
   memory**, keyed by a `termsCommitment`.
5. The client finalizes with a relay call that verifies the TEE signature; only the **commitment**
   lives on-chain until settlement.

The commitment (`keccak256(abi.encode(params))`) is what links on-chain state to TEE-held secrets
without revealing them, and lets a later reveal be checked against what was originally committed.

---

## 9. Deployment

### 9.1 Four-phase lifecycle

| Phase | Script | What happens |
| --- | --- | --- |
| **1. pre-build** | `pre-build.sh` | Compile Solidity, deploy `InstructionSender`, register the extension on `TeeExtensionRegistry`, write `EXTENSION_ID` + `INSTRUCTION_SENDER` to `config/extension.env` |
| **2. start services** | `start-services.sh` | `docker compose up -d --build` — starts `redis`, `ext-proxy`, `extension-tee` |
| **3. post-build** | `post-build.sh` | `allow-tee-version` (whitelist code hash) → `set-governance` (register TEE governance signer set/threshold) → `register-tee -command rRap` (register machine, fresh attestation, FTDC check, promote to production) |
| **4. test** | `test.sh` | Send instructions through the deployed TEE and verify the round-trip |

`full-setup.sh --chain coston2 --test` runs all four.

`register-tee -command rRap` — the **capital `R`** issues a fresh attestation challenge on re-runs,
avoiding `Verification.ChallengeExpired`.

### 9.2 Docker service topology

| Service | Role |
| --- | --- |
| `extension-tee` | Your extension code + `tee-node` |
| `ext-proxy` | Watches chain for instructions, forwards to handler, submits results back on-chain |
| `redis` | In-memory store for the proxy |

| Service | Container port | Host port |
| --- | --- | --- |
| `ext-proxy` internal | 6663 | 6673 |
| `ext-proxy` external | 6664 | **6674** |
| `redis` | 6379 | 6382 |

An HTTPS tunnel (ngrok or cloudflared) exposes host port **6674** publicly and its URL becomes
`EXT_PROXY_URL`.

> **`EXT_PROXY_URL` must be set *before* deploying the contract or starting services** —
> `post-build.sh`, `start-services.sh`, and `test.sh` all read it from `.env`. Setting it late means
> redoing the deploy.

> **Security:** exposing port 6674 makes the proxy HTTP API public — anyone with the URL can call it.
> Testnet only; stop the tunnel when finished.

### 9.3 Real testnet requirements

- Funded deployer key ([Coston2 faucet](https://faucet.flare.network/coston2))
- Publicly reachable HTTPS proxy URL → port 6674
- **Indexer DB credentials** for the proxy (Coston2: host `34.38.42.208`, port `3306`, database
  `indexer`) — obtained on request via [Flare support](https://flare.network/resources/technical-support)
  or [@flare_network](https://x.com/flare_network)
- A **GCP Confidential Space VM** to run the image
- `LOCAL_MODE=false`, `SIMULATED_TEE=false`, image built with `MODE=0`

Coston2: RPC `https://coston2-api.flare.network/ext/C/rpc`, chain ID **114**.
Coston: RPC `https://coston-api.flare.network/ext/C/rpc`, chain ID **16**.

### 9.4 Failure modes

| Error | Cause and fix |
| --- | --- |
| `Verification.TeeNotFound` | `NORMAL_PROXY_URL` points at the wrong chain's FTDC proxy |
| `Verification.ChallengeExpired` | Re-run post-build; ensure `register-tee -command rRap` |
| `InvalidGovernanceHash` | `GOVERNANCE_SIGNERS`/`GOVERNANCE_THRESHOLD` don't match what the TEE node signed. Leave both unset for deployer-only defaults, or align `.env` and the container |
| `code hashes do not match` | `SIMULATED_TEE` and image `MODE` disagree. Local: `SIMULATED_TEE=true` + `MODE=1`. Live: `false` + `0` |
| `MachineManager.TooMany()` | `config/extension.env` extension ID doesn't match the on-chain TEE record — usually after `pre-build.sh --force`. Full reset, or keep `extension.env` and re-run only post-build + test |
| `connect: connection refused` from ext-proxy | Route to Flare's indexer DB is down |
| TEE registration times out | `docker compose restart ext-proxy`; FDC attestation needs active Coston2 relay providers |

> **`pre-build.sh --force` is a footgun.** It deploys a new `InstructionSender` and registers a new
> extension ID, which causes `MachineManager.TooMany()` if an older TEE machine is still registered
> under the previous ID. On-chain state cannot be reset — every `pre-build` deploys new contracts.

---

## 10. Known Limitations

Recorded honestly, because several constrain what Fidensur can truthfully claim.

1. **FCC is not production-ready.** Documented as "in the final stages of development." Fidensur is a
   Coston2 testnet application and must not present itself as production-grade custody.
2. **Storing encrypted secrets on-chain is not safe for production.** `fce-sign` says so explicitly:
   on-chain data is public and encryption weakens over time. Fidensur must not persist encrypted
   allocation data on-chain as a durable store — only as transient instruction payloads, with
   commitments for the durable record.
3. **Enclave memory is not durable.** The private-buy pattern holds plaintext terms in enclave memory
   keyed by commitment. A TEE restart loses it. Any design depending on long-lived enclave state
   needs an explicit recovery path.
4. **Cross-machine reproducibility is Go-only.** Python and TypeScript reach same-machine determinism
   only. Decisive for the language choice.
5. **~2 second `POST /action` budget** forces the async pattern for any non-trivial computation.
6. **Single-TEE routing is the default.** `getRandomTeeIds(id, 1)` means one machine, one signature,
   one point of failure. Multi-TEE fan-out with cosigner thresholds exists but adds complexity.
7. **Diamond redeployment wipes all registrations.**
8. **Indexer DB credentials are gated** — required for `ext-proxy` and available only on request.
9. **Public HTTPS tunnel required.** The proxy must be internet-reachable; free-tier ngrok URLs can
   change, forcing `EXT_PROXY_URL` updates and a redeploy.
10. **`bytes32` identifiers cap at 31 bytes.**
11. **On-chain fees per instruction** — every allocation run costs the `sendInstructions` fee.

---

## 11. Missing / Thin Documentation

Gaps found while researching, where the code was the only real source of truth:

1. **`SIGN_PORT` value is inconsistent across sources** — `7701` in the extension contract and
   `docker-compose.yaml`, `9090` as the Go config default, `9090` in some prose. *Resolution: trust
   the compose file and container contract (`7701`); read the value from the environment, never
   hard-code it.*
2. **`POST /result` is under-documented.** It appears in weather-insurance's async pattern
   (`postActionResultToNode`) but is absent from the container-contract's §3 list of endpoints the
   extension may call. Its exact semantics on retry or duplicate submission are unspecified.
3. **No published ECIES encryption spec for clients.** The private-buy flow requires clients to
   encrypt to the TEE public key, but the curve, KDF, and MAC parameters are not documented
   prose-side — they must be inferred from `go-ethereum`'s `ecies` package.
4. **TEE public key retrieval is not documented as an endpoint.** `fce-sign`'s test flow "fetches the
   TEE public key" without the docs specifying which endpoint serves it.
5. **`additionalVariableMessages`, `timestamps`, `additionalActionData`, `signatures`, and
   `additionalFixedMessage`** are listed in the wire format with no explanation of when they are
   populated or what they mean.
6. **Cosigner workflow is unspecified.** `cosigners` and `cosignersThreshold` appear in
   `TeeInstructionParams`, and >50% signature weight is mentioned in the overview, but no guide shows
   a cosigner flow end to end.
7. **Result polling is not specified.** "Caller polls the proxy for the result" — the endpoint,
   shape, and expected latency are not documented.
8. **`claimBackAddress` semantics** — presumably refund of unused instruction fee, but not stated.
9. **`rewardEpochId` in `DataFixed`** is unexplained.
10. **No fee schedule.** `sendInstructions` is payable and `TeePaymentsFeeScheduleManager` exists
    on-chain, but the actual per-instruction cost is not documented.
11. **`SubmissionTag` values** (`"threshold"`, `"end"`, `"submit"`) are enumerated but their
    selection logic is not explained.

---

## 12. Assumptions Made

Where documentation is silent, Fidensur proceeds on these assumptions. Each is falsifiable and
should be re-checked against a live deployment.

| # | Assumption | Basis | Risk if wrong |
| --- | --- | --- | --- |
| A1 | `SIGN_PORT` is read from env (`7701` in compose) and never hard-coded | compose + container contract | Low — env-driven either way |
| A2 | `POST localhost:$SIGN_PORT/result` is the supported async completion path | weather-insurance production usage | Medium — async path breaks; would need sync-only handlers |
| A3 | ECIES is `go-ethereum`'s `ecies` over secp256k1 (AES-128-CTR + HMAC-SHA-256) | `/decrypt` is served by Go `tee-node` | Medium — private-allocation encryption fails; falls back to public-commitment mode |
| A4 | `submissionTag` is `"submit"` for developer-extension instruction results | weather-insurance passes `"submit"` to `settle()` | Medium — signature verification fails; tag is a call parameter, so recoverable |
| A5 | `status == 1` is the only relayable status on-chain | explicit in weather-insurance | Low |
| A6 | `claimBackAddress` receives unused instruction fees; `msg.sender` is the right value | scaffold and weather-insurance both pass `msg.sender` | Low |
| A7 | One TEE (`getRandomTeeIds(id, 1)`) is acceptable for v1 | both reference apps do this | Low for a demo; **high for real custody** — recorded as a limitation |
| A8 | Enclave memory persists across instructions within one TEE lifetime, but not restarts | weather-insurance keys private terms by commitment in memory | Medium — mitigated by making every commitment independently re-derivable |
| A9 | The types server (port 8100) is optional infrastructure the app may host | present in weather-insurance, absent from the scaffold's required surface | Low |
| A10 | `keccak256(abi.encode(...))` commitments are the intended link between on-chain state and TEE-held secrets | weather-insurance `termsCommitment` | Low |

### 12.1 Settled by the first live round — 10 Aug 2026

`./scripts/test.sh` ran a complete round against the Coston2 deployment (round 1 on
`0xF4711694…`). The original entries above are left unedited as the research record; this is what
the run actually decided.

| # | Outcome |
| --- | --- |
| **A2** | **Confirmed.** `COMPUTE` acknowledged with status 2 and delivered via `POST localhost:$SIGN_PORT/result`; the signed result arrived and verified. |
| **A3** | **Confirmed, and it was the point of the exercise.** The browser's `lib/ecies.ts` ciphertext was decrypted by `tee-node`, and the enclave's disclosure was decrypted by the browser. No self-test could have established this — two identically wrong implementations round-trip perfectly. |
| **A4** | **Confirmed.** The proxy reported `submissionTag: "submit"` and `finalizeRound` accepted a signature computed over it. |
| **A5** | **Confirmed.** Status 1 relayed and verified on-chain. |
| **A8** | **Confirmed.** `DISCLOSE` located the table `COMPUTE` had built, keyed by policy commitment, in a later instruction on the same enclave. |

**A6 remains untested** — the round paid the fee but never checked whether the unused portion came
back to `claimBackAddress`.

Two documentation gaps from §11 also closed:

- **Item 7, the result endpoint.** It is `GET {proxy}/action/result/{actionId}`, and the response is
  `types.ActionResponse`: `{ result: {...}, signature, proxySignature }` — with **the signature a
  sibling of `result`, not a field inside it**. Authority is `fccutils.ActionResult` in the Flare
  scaffold, whose comment marks it "do not modify".
- **Item 10, the fee.** The scaffold sends `opts.Value = big.NewInt(1000000)` — 1,000,000 wei per
  instruction. Still not a published schedule, but it is what the reference tooling uses and it
  worked.

One gap the run did **not** close, and could not: `tee-proxy` serves no CORS headers, so no browser
can read any of these endpoints. The script runs in Node, which does not enforce CORS. See
`deployment.md` Phase 6.

---

## 13. Source Provenance

Repositories cloned and read directly (not summarized) on **2026-07-28**:

| Repository | Commit | What was read |
| --- | --- | --- |
| [`flare-foundation/flare-ai-skills`](https://github.com/flare-foundation/flare-ai-skills) | `main` | `skills/flare-fcc-skill/{SKILL.md,reference.md}` |
| [`flare-foundation/fce-extension-scaffold`](https://github.com/flare-foundation/fce-extension-scaffold) | `f48cafb889441a62e47c083f4be8dd7d3f456f83` (2026-07-28) | contracts, interfaces, `docs/extension-contract.md`, Go extension + config + types + server, `go/Dockerfile`, `docker-compose.yaml`, `.env.example`, `config/coston2/deployed-addresses.json`, tools |
| [`flare-foundation/fce-sign`](https://github.com/flare-foundation/fce-sign) | `main` | deployment lifecycle, multi-language framework |
| [`flare-foundation/fce-weather-insurance`](https://github.com/flare-foundation/fce-weather-insurance) | `main` | `contracts/InstructionSender.sol` (TEE verification, ECIES private buy), `internal/extension/utils.go` (async pattern, `/decrypt`, `/result`), `pkg/types/register.go` (types-server decoders) |

### Documentation pages referenced

- [Flare Developer Hub](https://dev.flare.network/)
- [FCC Overview](https://dev.flare.network/fcc/overview)
- [FCC Guides index](https://dev.flare.network/fcc/guides)
- [Build Your First Extension — Getting Started](https://dev.flare.network/fcc/guides/getting-started)
- [Private Key Extension Guide (`sign-extension`)](https://dev.flare.network/fcc/guides/sign-extension)
- [Weather Insurance Extension Guide](https://dev.flare.network/fcc/guides/weather-insurance-extension)
- [FCC Whitepaper — *Powering Interoperability for Flare through TEEs* (2026-07-06)](https://dev.flare.network/pdf/whitepapers/20260706-FlareConfidentialCompute.pdf)
- [FDC Overview](https://dev.flare.network/fdc/overview)
- [Network Overview](https://dev.flare.network/network/overview)

### Repository documents referenced

- [Extension Container Contract](https://github.com/flare-foundation/fce-extension-scaffold/blob/main/docs/extension-contract.md) — **normative**
- [Extension Development Guide](https://github.com/flare-foundation/fce-extension-scaffold/blob/main/docs/extension-guide.md)
- [InstructionSender Contract Guide](https://github.com/flare-foundation/fce-extension-scaffold/blob/main/docs/instruction-sender.md)
- [Types Server Guide](https://github.com/flare-foundation/fce-extension-scaffold/blob/main/docs/types-server.md)
- [Testing Guide](https://github.com/flare-foundation/fce-extension-scaffold/blob/main/docs/testing.md)
- [Deployment Steps](https://github.com/flare-foundation/fce-extension-scaffold/blob/main/docs/deployment-steps.md)
- [Making It Your Own](https://github.com/flare-foundation/fce-extension-scaffold/blob/main/docs/manual-setup.md)
- [`fce-sign` REPRODUCIBILITY.md](https://github.com/flare-foundation/fce-sign/blob/main/REPRODUCIBILITY.md)
- [`ITeeExtensionRegistry.sol`](https://github.com/flare-foundation/fce-extension-scaffold/blob/main/contracts/interfaces/ITeeExtensionRegistry.sol)
- [`ITeeMachineRegistry.sol`](https://github.com/flare-foundation/fce-extension-scaffold/blob/main/contracts/interfaces/ITeeMachineRegistry.sol)

### Platform references

- [GCP Confidential Space overview](https://cloud.google.com/confidential-computing/confidential-space/docs/confidential-space-overview)
- [Confidential Computing / remote attestation docs](https://docs.cloud.google.com/confidential-computing/docs)
- [AMD SEV](https://www.amd.com/en/developer/sev.html)
- [Coston2 faucet](https://faucet.flare.network/coston2)
- [moby/buildkit#3180 — rewrite-timestamp clamps only downward](https://github.com/moby/buildkit/issues/3180)

---

## 14. Key Takeaways for Fidensur

The design decisions in [`architecture.md`](./architecture.md) follow from these findings:

1. **Go, not Python or TypeScript** — bit-for-bit cross-machine reproducibility is the whole basis of
   the public-verifiability claim ([§8.2](#82-reproducible-builds)).
2. **The async handler pattern is mandatory** — allocation over a recipient set exceeds the ~2s POST
   budget ([§3.1](#31-timing-constraint--the-2-second-post-budget)).
3. **ABI-encode `ActionResult.Data`**, not JSON — the settlement contract must `abi.decode` it
   ([§8.3](#83-on-chain-verification-of-a-tee-result)).
4. **Domain-separated signature verification, copied exactly** — `TEE_ACTION_RESULT` + `chainId` +
   `resultHash`, EIP-191 wrapped. Verifying the bare `resultHash` silently fails.
5. **Commitments, not ciphertext, are the durable on-chain record** — storing encrypted secrets
   on-chain is explicitly unsafe ([§10](#10-known-limitations) item 2).
6. **The InstructionSender is the authorization boundary** — the registry guarantees it is the sole
   caller, so all access control belongs there ([§4.1](#41-iteeextensionregistry)).
7. **Extension ID is derived, never hard-coded** — diamond redeployment invalidates it
   ([§2](#2-architecture-summary)).
8. **Publish the code hash and `SOURCE_DATE_EPOCH`** — without both, a third party cannot reproduce
   the build and the verification story is incomplete ([§8.1](#81-attestation)).
