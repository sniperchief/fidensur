# Deploying Fidensur on Coston2

End-to-end, from a fresh machine to a verified confidential round.

**Current state of this deployment:**

| | |
| --- | --- |
| Contract | [`0xF471169436d475917A63780EF13d9a4320c914b9`](https://coston2-explorer.flare.network/address/0xF471169436d475917A63780EF13d9a4320c914b9) |
| Extension ID | 65818 (`0x1011a`) |
| Deployer | `0xf540e9E4417d1326f533A839Cfb683b80C57F161` |
| Remaining | TEE stack — needs a host with Docker |

Phases 1–2 are **done**. This document covers 3–5.

---

## Why a separate machine

The TEE stack is `redis` + `ext-proxy` + `extension-tee` under Docker Compose. Docker Desktop wants
8 GB of RAM, and on a 4 GB Windows laptop WSL2 alone consumes most of that.

Two things make this easier than it sounds:

- **No GCP Confidential Space needed.** `SIMULATED_TEE=true` is accepted on Coston2, and a simulated
  TEE reaches `PRODUCTION` in seconds on a current stack. Real attestation only matters for a
  production deployment, and the verification explorer says so explicitly rather than pretending
  otherwise.
- **A VM with a public IP removes the tunnel entirely.** That sidesteps the most common cause of a
  machine stranded at `INITIALIZED` — see [§3.2](#32-the-url-trap).

Any 2 GB Linux box will do. Oracle Cloud's always-free tier, Hetzner (~€4/mo), DigitalOcean, or a
GCP e2-micro are all sufficient.

---

## Phase 3 — Prepare the host

### 3.1 Install Docker

On Ubuntu 22.04 or 24.04:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
newgrp docker          # or log out and back in
docker run hello-world # verify
```

### 3.2 The URL trap

Data providers push results to the URL **stored on-chain** at registration. If that hostname later
changes, the chain keeps pointing at the dead one — your queue stays empty, and nothing anywhere
reports an error. Machines stuck at `INITIALIZED` are usually this.

| Option | Verdict |
| --- | --- |
| VM's public IP + open port 6674 | **Best** — nothing to rotate |
| Named `cloudflared` tunnel | Fine — stable hostname |
| Reserved ngrok domain | Fine — stable hostname |
| `trycloudflare` quick tunnel | **Never** — hostname changes on every restart |
| ngrok free ephemeral URL | **Avoid** — same failure |

With a public IP, open the port and use it directly:

```bash
sudo ufw allow 6674/tcp
# then in .env:
#   EXT_PROXY_URL=http://<your-public-ip>:6674
```

> **This exposes the proxy HTTP API to the internet.** Anyone with the URL can call it. Testnet
> only, and shut it down when you are finished.

### 3.3 Clone and configure

```bash
git clone https://github.com/sniperchief/fidensur.git
cd fidensur
cp .env.example .env
```

Fill in `.env`:

```bash
DEPLOYMENT_PRIVATE_KEY=<64 hex chars, no 0x>
INITIAL_OWNER=0xf540e9E4417d1326f533A839Cfb683b80C57F161
EXT_PROXY_URL=http://<public-ip-or-stable-hostname>:6674
```

Then the proxy's database credentials:

```bash
cp config/proxy/extension_proxy.docker.toml.example \
   config/proxy/extension_proxy.docker.toml
```

Fill in the `[db]` block with the Coston2 indexer credentials. These are issued by Flare and are not
in the public docs — the ones that used to be published are dead. Both files are gitignored.

Finally, tell the stack which extension it serves:

```bash
cat > config/extension.env <<'EOF'
EXTENSION_ID=65818
INSTRUCTION_SENDER=0xF471169436d475917A63780EF13d9a4320c914b9
FIDENSUR_CONTRACT=0xF471169436d475917A63780EF13d9a4320c914b9
EOF
```

> **`EXTENSION_ID` must equal what `extensionId()` returns on-chain**, which is not necessarily what
> a registration call reported. Registration is not idempotent: running it twice binds one contract
> to two IDs, and `setExtensionId()` caches the **lowest** one permanently. Using the other value
> points the TEE node at an extension the contract never addresses, and the symptom appears much
> later as `MachineManager.TooMany()`. Verify with `./scripts/check-tee-status.sh`.

### 3.4 Check before starting

```bash
./scripts/check-tee-status.sh
```

Expected:

```
--- registry ---
  ok    TEE_MANAGER_ADDRESS is the live Coston2 deployment
--- extension ---
  extensionId() says:  65818
  config says:         65818
  ok    they match
  warn  teeAddress is unset — expected until post-build
```

---

## Phase 4 — Start the stack

### Pull the image; do not build it

Building the extension image compiles go-ethereum and needs roughly **4 GB**. On a modest host it
will be OOM-killed.

CI publishes the image after proving it reproducible on two independent runners, so pull that
instead:

```bash
export FIDENSUR_IMAGE_TAG=<commit-sha>     # from the CI run summary
docker compose pull
docker compose up -d
```

Pin a **commit SHA**, not `latest`. The SHA names one exact commit, so the running image and the
source someone rebuilds to verify it are unambiguously the same thing — which is the entire point of
the reproducibility work. `latest` moves and cannot make that claim.

This is also correctness, not just convenience: the CI image is the artifact whose hash was actually
verified. A local rebuild is a different artifact until proven otherwise.

> The images are private until you make them public, once, at
> `https://github.com/<you>/fidensur/pkgs/container/fidensur-extension`.

### Or build locally, if the host has the memory

```bash
./scripts/start-services.sh
```

This derives `SOURCE_DATE_EPOCH` from the last commit, builds the image, and starts `redis`,
`ext-proxy`, and `extension-tee`. Reach for this when developing the extension itself, not for a
deployment.

The script waits for the proxy and prints its attestation report. Confirm the proxy is reachable
from outside the VM too:

```bash
curl -s "$EXT_PROXY_URL/info" | jq '.machineData'
```

If it answers locally but not through `EXT_PROXY_URL`, the firewall or tunnel is wrong — fix that
before registering, because the URL gets written on-chain.

**If the proxy will not start**, check `docker compose logs ext-proxy` first. A database sync error
means the indexer credentials are wrong or unreachable, and it is by far the most common cause: the
proxy starts, reports healthy, and its queue silently stays empty.

---

## Phase 5 — Register the TEE machine

```bash
./scripts/post-build.sh
```

That script runs every locally checkable precondition and then hands off to the Flare scaffold's
tools, which perform the attestation handshake:

```bash
git clone https://github.com/flare-foundation/fce-extension-scaffold.git ../fce-extension-scaffold
```

Three steps, in order:

1. `allow-tee-version` — whitelists the measured code hash
2. `set-governance` — registers the TEE governance signer set and threshold
3. `register-tee -command rRap` — registers the machine and issues a **fresh** attestation challenge

> The capital **R** in `rRap` is what issues a fresh challenge. Without it a re-run fails with
> `Verification.ChallengeExpired`.

### Then point the contract at the machine

```bash
cast send 0xF471169436d475917A63780EF13d9a4320c914b9 \
  'setTeeAddress(address)' <TEE_MACHINE_ADDRESS> \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc \
  --private-key "$DEPLOYMENT_PRIVATE_KEY"
```

Until this is set, `finalizeRound` reverts with `TeeAddressNotSet` — the contract refuses to verify
against a zero address rather than letting `ecrecover` edge cases decide.

### Verify

```bash
./scripts/check-tee-status.sh <TEE_MACHINE_ADDRESS>
```

Look for `status: 2 = PRODUCTION`. On a current stack a simulated TEE reaches it in seconds.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Machine stuck at `INITIALIZED` | On-chain URL is dead — rotated tunnel. Update `EXT_PROXY_URL`, re-run post-build |
| Queue never fills, no errors | tee-node older than v0.0.22 — every data-provider vote is silently rejected |
| `FunctionNotFound`, `register()` reverts | Stale `FlareTeeManager`. The live one is `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` |
| `Verification.ChallengeExpired` | Re-run post-build; ensure `register-tee -command rRap` |
| `InvalidGovernanceHash` | `GOVERNANCE_SIGNERS`/`GOVERNANCE_THRESHOLD` disagree with what the node signed. Leave both unset for the deployer-only default |
| `code hashes do not match` | `MODE` and `SIMULATED_TEE` disagree. Simulated: `MODE=1` + `true`. Real: `MODE=0` + `false` |
| `MachineManager.TooMany()` | `EXTENSION_ID` does not match `extensionId()` on-chain |
| Proxy healthy but no instructions | Indexer DB credentials wrong. Check `docker compose logs ext-proxy` |

---

## What a working deployment proves

Once a round completes end to end:

1. **ECIES interoperability with go-ethereum** — the one thing that cannot be verified locally. The
   browser encrypts the policy and the enclave decrypts it; a self-test proves only internal
   consistency, since two identically wrong implementations round-trip perfectly.
2. **The full instruction lifecycle** — contract → registry → proxy → node → extension → signed
   result → on-chain verification.
3. **The verification explorer against real attestation data**, rather than fixtures.

Until then, everything else is verified: 178 tests, a reproducible image built identically on two
independent machines, and a contract deployed and registered on Coston2.
