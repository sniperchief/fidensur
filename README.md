# Fidensur

**Allocate funds privately. Prove the computation publicly.**

Confidential treasury allocation on [Flare Confidential Compute](https://dev.flare.network/fcc/overview).

An organization funds a round, commits to an encrypted allocation policy, and asks a TEE to
evaluate it. The enclave returns only an aggregate — a Merkle root, a total, a recipient count —
signed with its attested key. Individual addresses, amounts, and allocation rules never reach the
chain. Anyone can verify that a specific published program ran inside a real TEE and produced that
aggregate, without learning anything it was meant to hide.

---

## Build status

Read this before anything else. Not every part of this repository is equally verified, and the
difference matters.

| Component | State | Verified how |
| --- | --- | --- |
| `docs/fcc-research.md` | Complete | Written from the Flare Developer Hub plus the `fce-extension-scaffold`, `fce-sign`, and `fce-weather-insurance` repos, cloned and read at the commits listed in §13 |
| `docs/architecture.md` | Complete | — |
| `contracts/` | Complete | **102 Forge tests passing** (`forge test`) |
| `extension/` (Go) | Complete | **`go build`, `go vet`, and 26 tests all passing** |
| Go ↔ Solidity Merkle agreement | **Verified** | Go reproduces Solidity-generated leaf hashes and roots byte-for-byte |
| `scripts/check-op-sync.sh` | Complete | Passing — identifiers agree across all three layers |
| `scripts/{pre-build,start-services,post-build}.sh` | Complete | Syntax-checked; ⚠️ never run against a chain |
| `extension/tools/cmd/register-extension` | Complete | Compiles and vets clean; ⚠️ never run against a chain |
| `frontend/lib/*.ts` | Complete | **`tsc --noEmit` clean; 51 tests passing** (`npm test`) |
| Browser verifier ↔ Solidity agreement | **Verified** | TypeScript reproduces the Solidity signature chain and recovers the same signer |
| Verification explorer (`/verify`, `/verify/[round]`) | Complete | Every verdict derived from chain state and the live attestation report; signature recovered in the browser |
| Organization console (`/org`) | Complete | **Drove a real round end to end in a browser** — create → fund → commit → compute → finalize |
| Recipient portal (`/claim`) | Complete | **A recipient disclosed and claimed in a browser**, Merkle proof re-verified client-side before spending |
| Workspace dashboard (`/dashboard`) | Complete | Every figure read from `getRound()`. There is no mock-data module in this project |
| Marketing site (`/`) | Complete | Illustrative figures only, labelled as illustrations in the UI |
| `extension/Dockerfile` | Complete | **Reproducible across two independent CI runners** |
| `docker-compose.yaml` | Written | ⚠️ Never run |
| `.github/workflows/ci.yml` | Complete | **All 8 jobs green** |

### What is and is not proven

**Proven by a passing test run** (179 tests: 102 Forge + 26 Go + 51 TypeScript):

- The contracts behave as specified, with negative cases for every threat in
  `docs/architecture.md` §9.1 — forged signatures, cross-chain replay, cross-round replay, relaying
  a TEE *failure* as success, over-allocation, double-claims, front-running.
- The allocation engine is deterministic across repeated runs and independent of input ordering —
  the property the entire verification argument rests on.
- **The Go engine and the Solidity verifier agree byte-for-byte on Merkle leaves and roots.** This
  is the one that would otherwise bite hardest: a drift there makes every claim in a round fail with
  `BadMerkleProof`, which looks like a corrupted proof rather than a version skew.

- **The browser verifier and the Solidity verifier agree.** `frontend/lib/verify.ts` reimplements
  `TeeResultVerifier.sol` rather than calling it, so that a reader who distrusts the contract can
  still check a signature. The tests confirm the two land on the same signer, step by step —
  otherwise the duplication would just be duplication.

- **Cross-machine reproducibility holds.** CI builds the TEE image on two independently provisioned
  runners and compares manifest digests. They match. This is the property Fidensur's public
  verifiability rests on: a third party can rebuild the published source and confirm the attested
  code hash for themselves.

  Getting there took three failures worth recording, because each was a real defect rather than a
  flaky pipeline:

  1. The build pinned apt to `snapshot.debian.org` keyed on `SOURCE_DATE_EPOCH` — but that value is
     the current commit's timestamp, and the snapshot service lags real time, so a fresh commit had
     no snapshot to resolve. The step was also unnecessary: the only file taken from Debian is
     `ca-certificates.crt`, which the digest-pinned base image already provides.
  2. `SOURCE_DATE_EPOCH` was passed only as a `--build-arg`. That clamps file mtimes inside the
     Dockerfile, but BuildKit reads the *environment* variable, and normalizing mtimes recorded in
     layer tars additionally needs `rewrite-timestamp=true` on the output.
  3. Plain `docker build` routed to the classic docker driver, which rejects the OCI exporter
     outright. The build now names the `docker-container` builder explicitly.

  A single local build would have produced a code hash and quiet confidence at every one of those
  stages. Two independent machines is what made the difference between a claim and a fact.

- **Deployed and registered on Coston2.** The contract is live, the extension is registered, and
  `setExtensionId()` has resolved. See [Live deployment](#live-deployment).

- **A confidential round has run end to end — and then a browser did it.** Round 1 was computed by
  the enclave and finalized on-chain via `scripts/test.sh` on 10 August 2026. A later round was
  driven entirely through the web application: created, funded, committed, computed, finalized,
  disclosed and claimed.

  Those are two separate results and the second is not a formality. `scripts/test.sh` runs in Node,
  **which does not enforce CORS at all**, so a green scripted run proved nothing about whether a
  browser could reach the same proxy. Phase 6 of [`docs/deployment.md`](docs/deployment.md) exists
  precisely because it could not, and the browser round is what closed it.

- **ECIES interoperability with go-ethereum is confirmed.** The browser encrypted a policy and the
  enclave decrypted it; the enclave encrypted a disclosure and the browser decrypted that. This was
  assumption **A3** in `fcc-research.md`, and no self-test could ever have settled it — two
  identically wrong implementations round-trip against each other perfectly.

**Unproven:**

- **Attestation is simulated, and that is the one thing missing.** The enclave runs as an ordinary
  container with `SIMULATED_TEE=true`, which Coston2 accepts. The program is real, the ECIES is
  real, the Merkle tree is real, the signature is real and the contract really recovers it — but
  the attestation report carries a placeholder platform string and a placeholder code hash instead
  of a hardware measurement. Nothing here establishes that the machine was hardware-isolated, so
  nothing here rules out the operator having read the policy.

  Real attestation needs a GCP Confidential Space VM. It is a deployment configuration, not a
  change to any code above.

  The verification report checks for exactly this and reports **FAIL** on it, distinguishing a
  simulated enclave from an integrity failure rather than collapsing the two into one word.

## Live deployment

| | |
| --- | --- |
| Network | Coston2 (chain ID 114) |
| Contract | [`0xF471169436d475917A63780EF13d9a4320c914b9`](https://coston2-explorer.flare.network/address/0xF471169436d475917A63780EF13d9a4320c914b9) |
| Extension ID | 65818 (`0x1011a`) |
| TEE machine | `0x84893f5D7D8FD55c6Ce834e45A41997E05C7B9F6` — `PRODUCTION`, simulated attestation |
| Proxy (browser-reachable) | `https://206.72.199.199.nip.io` — Caddy on 443, forwarding to 6674 |
| Attestation | Simulated — a real code hash needs a GCP Confidential Space VM |
| Rounds settled | Round 1 via `scripts/test.sh`; a later round entirely through the browser |

Full host setup, including the two problems that make a working deployment unusable from a browser,
is in [`docs/deployment.md`](docs/deployment.md).

### A deployment hazard worth knowing about

Registration is **not idempotent**, and the failure is quiet.

During this deployment a wrapper timed out *after* its registration transaction had already landed.
A retry then registered a second time, leaving the same contract bound to two valid extension IDs:
65818 and 65819. `setExtensionId()` scans upward from `0x10000` and caches the **first** match,
set-once — so the contract permanently uses 65818, while the tool reported 65819 and wrote that to
`config/extension.env`.

Nothing fails at that point. The mismatch surfaces much later as `MachineManager.TooMany()` during
TEE registration, with nothing linking it back to the duplicate.

`register-extension` now scans for an existing binding before registering, using the same
first-match order as the contract so the two cannot disagree. If you hit this on an older
deployment, the fix is to set `EXTENSION_ID` to whatever `extensionId()` returns on-chain — that
value is authoritative and cannot be changed.
### Two things no local test could have caught

`frontend/lib/ecies.ts` implements go-ethereum's scheme from a reading of its source, and its
`selfTest()` only proved internal consistency — two identically wrong implementations round-trip
perfectly. And `ext-proxy` sends no `Access-Control-Allow-Origin` header, which Node does not care
about, so the scripted end-to-end run passed against a proxy no browser could reach.

Both were settled only by running a round from a browser. See
[`docs/deployment.md`](docs/deployment.md) §6.

### Cross-implementation checks

Three of the four independent implementations are pinned against each other by committed vectors,
generated by the Solidity code that will do the real verifying:

| Vector | Generated by | Asserted by | Status |
| --- | --- | --- | --- |
| Merkle leaves and roots | `test/GenerateVectors.t.sol` | `extension/internal/engine/merkle_test.go` | **Passing** |
| TEE signature chain | `test/GenerateSigVectors.t.sol` | `frontend/lib/__tests__/verify.test.ts` | **Passing** |

There are four implementations of these schemes on purpose — Solidity verifies proofs on-chain, Go
builds trees inside the enclave, TypeScript verifies signatures in the browser, and a fourth builds
trees in the Forge tests. Independence is the point: agreement between implementations that share no
code is evidence, whereas one implementation calling itself is not. The vectors are what turn that
independence into an actual check rather than an aspiration.

---

## How it works

```
1. Organization builds an allocation policy and ECIES-encrypts it to the TEE's public key
   in the browser. Plaintext never leaves their machine.

2. submitPolicy(roundId, keccak256(ciphertext))     ← commitment lands on-chain FIRST
3. requestCompute(roundId, ciphertext)              ← contract rejects any other ciphertext

4. Instruction routes through TeeExtensionRegistry to the enclave.
5. Enclave decrypts, evaluates the rules, builds a Merkle tree over (recipient, amount).
6. Enclave returns ONLY: merkleRoot, totalAllocated, recipientCount, policyCommitment.
   tee-node signs it with its attested key.

7. finalizeRound(...)  ← permissionless; anyone holding the signed result can submit it.
   The contract ecrecovers the signature and checks it against the registered TEE address.

8. Recipients call requestDisclosure() and get their own entry back, encrypted to them alone.
9. claim(roundId, index, amount, proof)  ← Merkle proof against the on-chain root.
```

### What is private, what is public

| Data | On-chain | Public |
| --- | --- | --- |
| Recipient addresses | ✗ | ✗ |
| Individual amounts | ✗ | ✗ |
| Allocation rules (weights, caps, bands) | ✗ | ✗ |
| Policy commitment, Merkle root, total, recipient count | ✓ | ✓ |
| TEE signature and attested code hash | ✓ | ✓ |
| **A recipient's address *and* their amount, once they claim** | ✓ | ✓ |

That last row is the honest caveat. **Claiming is self-disclosure** — `AllocationClaimed` carries
the recipient *and* the amount, and the transfer is visible regardless, so a claim publishes the
triple: this address received this amount from this round.

Until then a recipient does not appear on-chain at all — not their address, not their amount, not
the fact they were included. The model is **invisible until you spend, then visible**, and the
policy that decided the split is never published either way. This is not anonymity, and it does not
survive the subtraction problem in [Known gaps](#known-gaps) §9.

---

## Why Flare Confidential Compute

Each core mechanism maps to a capability only FCC provides:

| Requirement | FCC capability |
| --- | --- |
| Rules and amounts must never be public | Enclave computation on ECIES-encrypted input, decrypted via `tee-node`'s `/decrypt` |
| Anyone can confirm the computation ran | Domain-separated TEE signature, `ecrecover`-verified on-chain |
| Anyone can confirm *which program* ran | On-chain code-hash allowlist + reproducible Go build |
| Only authorized parties can trigger allocation | The registry binds the extension to exactly one InstructionSender |
| A recipient learns their amount and no one else's | The TEE encrypts a per-recipient disclosure to that recipient's key |

Remove FCC and there is no product. A ZK circuit could prove correct summation, but not that a
*specific published binary* processed a *confidential policy* — and it could not keep the allocation
rules themselves secret while doing so.

---

## Repository layout

```
contracts/
  Fidensur.sol                    the registered InstructionSender + treasury + claims
  libraries/
    TeeResultVerifier.sol         domain-separated TEE signature verification
    AllocationMerkle.sol          leaf encoding + proof verification
    SafeTransfer.sol              native + non-standard ERC-20 transfers
  interfaces/                     ITeeExtensionRegistry, ITeeMachineRegistry (from the scaffold)

extension/                        the Go FCC extension
  cmd/docker/                     container entrypoint (tee-node + engine, one process)
  cmd/types-server/               read-only decoder sidecar for the explorer
  internal/config/                OPType/OPCommand constants — one of three copies
  internal/engine/
    engine.go                     routing + the three handlers
    allocate.go                   deterministic allocation rules
    merkle.go                     Merkle construction, byte-compatible with Solidity
    crypto.go                     ECIES decrypt (via node) / encrypt (local)
  pkg/types/                      wire types and ABI layouts

frontend/                         Next.js app — no backend, no API routes, nothing server-side
  app/
    page.tsx                      marketing site
    dashboard/                    workspace overview + allocations, read from chain
    org/                          organization console: create → fund → commit → compute → finalize
    claim/                        recipient portal: disclose, re-verify the proof, claim
    verify/                       public explorer; /verify/[round] is the report
  lib/                            verify.ts (reimplements TeeResultVerifier.sol in the browser),
                                  ecies.ts, merkle.ts, policy.ts, verdict.ts
  components/                     design system, marketing sections, console, report

test/                             Forge tests
docs/
  fcc-research.md                 FCC knowledge base — read this first
  architecture.md                 design, trust model, threat model
  deployment.md                   host setup, TEE registration, and the CORS layer
```

---

## Getting started

### Prerequisites

| Tool | Needed for | Install |
| --- | --- | --- |
| [Foundry](https://book.getfoundry.sh/) | Contracts and tests | `curl -L https://foundry.paradigm.xyz \| bash` |
| Go 1.25+ | The extension | `winget install GoLang.Go` |
| Docker Desktop | Building the TEE image | `winget install Docker.DockerDesktop` |
| An HTTPS tunnel | Exposing the proxy | ngrok or cloudflared |

### Contracts

```bash
forge install foundry-rs/forge-std   # first time only
forge build
forge test
```

### Extension

```bash
cd extension
go mod tidy
go build ./...
go test ./...
```

### Frontend

```bash
cd frontend
npm install
npm test          # verifier and policy tests
npm run dev
```

Two environment values in `frontend/.env.local`, both public by nature — a contract address and a
proxy URL, neither of which is a secret:

```bash
NEXT_PUBLIC_FIDENSUR_CONTRACT=0xF471169436d475917A63780EF13d9a4320c914b9
NEXT_PUBLIC_EXT_PROXY_URL=https://206.72.199.199.nip.io
```

Without the proxy URL the app still reads the chain, but the confidential path is inert: `/org`
cannot encrypt (it fetches the enclave's public key from there), `/claim` cannot request a
disclosure, and `/verify` reports attestation as *unavailable* rather than treating a missing
report as a pass.

---

## Cross-implementation testing

The Go engine **builds** Merkle trees; the Solidity library **verifies** the resulting proofs
on-chain. Nothing structurally forces the two to agree — they are separate implementations in
separate languages — and if they drift, every claim in a round fails with `BadMerkleProof`, which
looks like a corrupted proof rather than a version skew.

So the Solidity side emits ground truth, and the Go side asserts against it:

```bash
# Regenerate vectors from the Solidity implementation
forge test --match-test test_emitVectors -vv
# → paste into extension/internal/engine/testdata/merkle_vectors.json

# Go asserts it reproduces them exactly
cd extension && go test ./internal/engine/ -run TestLeafHashMatchesSolidity -v
```

`test/helpers/MerkleBuilder.sol` is deliberately a *third* implementation, used only by the tests,
so a bug present in only one of the three shows up as a failure rather than as agreement.

---

## Security model

Full treatment in [`docs/architecture.md`](docs/architecture.md) §8–9. The load-bearing points:

**The signature scheme.** `tee-node` signs a domain-separated payload, not the bare result hash:

```
resultHash  = keccak256(keccak256(data) ‖ actionId ‖ keccak256(tag) ‖ status)
payloadHash = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), chainId, resultHash))
signature   = ECDSA over EIP-191 personal-sign of payloadHash
```

Verifying the bare `resultHash` compiles, runs, and rejects every genuine signature. The four
bindings each defeat a specific attack: `chainId` blocks cross-chain replay, `actionId` blocks
cross-round replay, `status` blocks relaying a TEE *failure* as a success, and the signer check
blocks forgery. `test/Fidensur.verification.t.sol` has a negative test for each.

**Solvency is enforced independently of the TEE.** `finalizeRound` requires
`totalAllocated <= funded`. A bug or a compromise in the allocation engine cannot create an
obligation the treasury cannot meet.

**Finalization is permissionless.** Anyone holding the signed result can submit it, so an
organization cannot suppress an outcome it dislikes by withholding the transaction.

**What Fidensur does not claim:** it is not anonymity; it does not protect against an organization
allocating *unfairly* (it proves the computation matched the committed policy, not that the policy
was just); it does not survive a broken AMD SEV; and FCC itself is documented as not yet
production-ready, so this is a Coston2 application.

---

## Known gaps

Carried from [`docs/fcc-research.md`](docs/fcc-research.md) §11–12. Each is resolved by testing
against a live deployment, not by reading more documentation.

1. ~~**ECIES parameters are assumed**, not documented.~~ **Resolved.** A browser-encrypted policy
   was decrypted by the live extension, and an enclave-encrypted disclosure was decrypted by the
   browser. The fallback public-commitment mode is not needed.
2. **`submissionTag` is assumed to be `"submit"`.** It is a parameter to `finalizeRound`, so a wrong
   assumption is recoverable without redeploying.
3. **Result polling is undocumented** — endpoint, shape, and latency. Isolated behind one module.
4. **The per-instruction fee is undocumented.** `requestCompute` forwards `msg.value` rather than
   hard-coding a figure.
5. **Enclave memory is not durable.** A TEE restart loses `DISCLOSE`/`ATTEST` state. Mitigated by
   `COMPUTE` being idempotent: re-submitting the same ciphertext reproduces the same root bit for
   bit, so recovery is "re-run COMPUTE". The organization must retain its ciphertext.
6. **Single-TEE routing.** `getRandomTeeIds(id, 1)` means one machine and one signature. Multi-TEE
   fan-out with a cosigner threshold is the obvious hardening step.
7. ~~**Indexer DB credentials are gated.**~~ **Resolved.** Credentials were issued and the stack
   runs end to end. Anyone reproducing this deployment still needs to request them from
   [Flare support](https://flare.network/resources/technical-support) before `ext-proxy` will see
   any instructions.

8. **`ext-proxy` sends no CORS headers**, so a browser can reach it only through a reverse proxy
   that adds them. Not a Fidensur bug, but it makes an otherwise working deployment unusable from
   the web application, and nothing in a Node-based test can detect it. Fixed here with Caddy —
   [`docs/deployment.md`](docs/deployment.md) §6.

9. **A round's remainder decays by subtraction.** Publishing `totalAllocated` alongside individual
   claims means that once every recipient but one has claimed, the last allocation is exactly
   known — published by other people's actions rather than its owner's. This is inherent: the total
   is what makes the round auditable. The verification report states it on the page rather than
   leaving it to be discovered.

---

## Documentation

- [`docs/fcc-research.md`](docs/fcc-research.md) — how FCC works: instruction lifecycle, wire
  format, attestation, reproducible builds, deployment lifecycle, limitations, and every source
  consulted
- [`docs/architecture.md`](docs/architecture.md) — Fidensur's design: contracts, extension, data
  flow, trust model, 20-item threat model, invariants

## License

MIT
