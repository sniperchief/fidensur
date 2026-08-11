# Deploying Fidensur on Coston2

End-to-end, from a fresh machine to a verified confidential round.

**Current state of this deployment:**

| | |
| --- | --- |
| Contract | [`0xF471169436d475917A63780EF13d9a4320c914b9`](https://coston2-explorer.flare.network/address/0xF471169436d475917A63780EF13d9a4320c914b9) |
| Extension ID | 65818 (`0x1011a`) |
| Deployer | `0xf540e9E4417d1326f533A839Cfb683b80C57F161` |
| TEE machine | `0x84893f5D7D8FD55c6Ce834e45A41997E05C7B9F6` — PRODUCTION, simulated attestation |
| Data-provider URL | `http://206.72.199.199:6674` (on-chain) |
| Browser URL | `https://206.72.199.199.nip.io` (Caddy, see Phase 6) |
| Status | Live. Round 1 completed end to end on 10 Aug 2026 |

Phases 1–2 are **done**. This document covers 3–6.

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

> This URL is for **data providers**, which are servers. The browser needs a different one — see
> [Phase 6](#phase-6--let-the-browser-reach-the-proxy). Serving only this port produces a
> deployment that registers correctly, passes every check, and still has a frontend that cannot
> function.

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

> **`EXTENSION_ID` must be 32-byte hex, not a decimal number.** tee-node strips an optional `0x`,
> hex-decodes the rest, and requires exactly 32 bytes. Writing the decimal form produces
> `invalid hex in environment variable EXTENSION_ID: encoding/hex: odd length hex string` — because
> `65818` is five characters.
>
> Worse, that failure is quiet: the node fails to initialise while the extension's own HTTP server
> starts anyway, so the container stays `Up` and `docker compose ps` looks healthy while nothing is
> served. Check `docker compose logs extension-tee` for `node initialization failed`.
>
> Convert with `printf '0x%064x\n' <decimal>`.

> **The value must equal what `extensionId()` returns on-chain**, which is not necessarily what a
> registration call reported. Registration is not idempotent: running it twice binds one contract to
> two IDs, and `setExtensionId()` caches the **lowest** one permanently. Using the other points the
> TEE node at an extension the contract never addresses, and the symptom appears much later as
> `MachineManager.TooMany()`. Verify with `./scripts/check-tee-status.sh`.

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

## Phase 6 — Let the browser reach the proxy

Everything above produces a working deployment that a **browser cannot use**. The frontend will
load, read the chain, and send transactions — and then fail at every step that needs the proxy:
requesting a computation result, requesting a disclosure, and showing the attestation report.

Two independent reasons, both of which the Caddy layer below fixes at once.

### 6.1 tee-proxy sends no CORS headers

Confirmed against a live deployment:

```console
$ curl -sD - -o /dev/null -H "Origin: https://example.com" http://<ip>:6674/info
HTTP/1.1 200 OK
Content-Type: application/json
Date: Tue, 11 Aug 2026 10:24:44 GMT
Content-Length: 1768
```

No `Access-Control-Allow-Origin`. A browser will make that request, receive that response, and then
refuse to hand it to JavaScript — because the response never granted permission. `curl` and any
server-side client are unaffected, which is exactly why this survives testing: `scripts/test.sh`
runs in Node, and **Node does not enforce CORS at all**. A green end-to-end run proves nothing about
whether the browser can do the same thing.

This applies to `http://localhost:3000` too. It is not a deployment problem; it is a browser
problem, and it is present from the first moment you open the app.

### 6.2 Mixed content

Any frontend served over HTTPS — Vercel, Netlify, GitHub Pages — cannot fetch `http://`. Browsers
block it outright as mixed content. So even with CORS solved, a plain-HTTP proxy is unreachable from
a deployed frontend.

### 6.3 Put Caddy in front — and leave 6674 alone

The fix is a second door, not a replacement. Data providers push to the URL written on-chain during
registration; changing what serves that port means re-registering. So Caddy listens on 443 and
forwards to 6674, which keeps serving exactly as before.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo NEEDRESTART_MODE=l apt install -y caddy
```

> **`NEEDRESTART_MODE=l` is not optional on a co-tenanted box.** Ubuntu's `needrestart` will
> otherwise offer to restart `docker.service`, and restarting Docker restarts `extension-tee` —
> whose signing key is generated fresh in memory on every boot. That silently invalidates the TEE
> registration and `teeAddress()`, and takes down anything else sharing the host. `l` means
> *list only*.

`/etc/caddy/Caddyfile`, using [nip.io](https://nip.io) so no domain purchase is needed —
`<ip>.nip.io` resolves straight to `<ip>`, which is enough for Let's Encrypt to issue a certificate:

```caddyfile
206.72.199.199.nip.io {
    reverse_proxy 127.0.0.1:6674

    header {
        Access-Control-Allow-Origin *
        Access-Control-Allow-Methods "GET, POST, OPTIONS"
        Access-Control-Allow-Headers "Content-Type"
    }

    @options method OPTIONS
    respond @options 204
}
```

`Access-Control-Allow-Origin *` is correct here rather than lax: the proxy serves attestation
metadata and signed results that are already public by construction, and it holds no cookies or
session state that a hostile origin could ride.

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp     # 80 is needed for the ACME challenge
sudo systemctl daemon-reload && sudo systemctl restart caddy
```

Verify, allowing ~30 seconds for the certificate:

```console
$ curl -sI https://206.72.199.199.nip.io/info | head -4
HTTP/2 200
access-control-allow-headers: Content-Type
access-control-allow-methods: GET, POST, OPTIONS
access-control-allow-origin: *
```

### 6.4 Point the frontend at it

```bash
# frontend/.env.local, and the same value in your host's environment variables
NEXT_PUBLIC_FIDENSUR_CONTRACT=0xF471169436d475917A63780EF13d9a4320c914b9
NEXT_PUBLIC_EXT_PROXY_URL=https://206.72.199.199.nip.io
```

One value serves both local development and a deployed frontend: an `http://localhost` page may
fetch `https://`, only the reverse is blocked. Next reads these at startup, so restart the dev
server after changing them.

Caddy costs about 30 MB resident, which matters if the host is shared.

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
| Frontend works except anything needing the proxy | No CORS headers — see [Phase 6](#phase-6--let-the-browser-reach-the-proxy). `curl` succeeds while the browser console shows a CORS error |
| Deployed frontend blocked, localhost fine over http | Mixed content. An HTTPS page cannot fetch `http://` |

---

## What a working deployment proves

`./scripts/test.sh` ran a full round against this deployment on 10 Aug 2026 — round 1 on
`0xF4711694…`, finalized on-chain. It settled three things that no local test could:

1. **ECIES interoperability with go-ethereum.** The browser encrypted the policy and the enclave
   decrypted it, then the enclave encrypted a disclosure and the browser decrypted that. This was
   assumption **A3** in `fcc-research.md`, and a self-test could never have confirmed it: two
   identically wrong implementations round-trip against each other perfectly.
2. **The full instruction lifecycle** — contract → registry → proxy → node → extension → signed
   result → on-chain verification, with the signature verified independently in TypeScript and in
   Solidity.
3. **The Merkle scheme across four implementations.** The proof was built in Go, checked in
   TypeScript, and spent against Solidity.

What it did **not** prove, and what Phase 6 exists to fix: that a *browser* can do any of this. The
script runs in Node, which does not enforce CORS, so it passed against a proxy no browser could
reach.

Alongside that: 179 tests, and a reproducible image built to an identical digest on two independent
machines.
