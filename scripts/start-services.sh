#!/usr/bin/env bash
#
# Phase 2 of the deployment lifecycle: build the TEE image and start the stack.
#
# The build is the security-critical part. The image's measured code hash is what gets whitelisted
# on-chain, and it is what a public verifier checks when asking "which program produced this
# allocation?". So the build must be reproducible: same source in, same hash out, on any machine.
# That is what SOURCE_DATE_EPOCH is for, and why this script derives it from the commit rather than
# letting it default to the current time.
#
# Usage: ./scripts/start-services.sh

set -euo pipefail

cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "error: .env not found. Copy .env.example and fill it in." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

if [[ ! -f config/extension.env ]]; then
  echo "error: config/extension.env not found — run ./scripts/pre-build.sh first." >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; source config/extension.env; set +a

# The proxy URL is baked into on-chain registration during post-build and read again by test.sh.
# Setting it after the stack is up means redoing the deploy, so fail now rather than later.
if [[ -z "${EXT_PROXY_URL:-}" || "$EXT_PROXY_URL" == *"<your-"* ]]; then
  echo "error: EXT_PROXY_URL is not set to a real URL in .env." >&2
  echo "" >&2
  echo "  Start a tunnel to host port 6674 and set it before continuing:" >&2
  echo "    ngrok http 6674" >&2
  echo "" >&2
  echo "  Security: this exposes the proxy HTTP API publicly. Testnet only, and stop the" >&2
  echo "  tunnel when you are done." >&2
  exit 1
fi

# A simulated code hash is rejected by Flare's data providers, so these two settings must agree.
# Mismatching them fails later with "code hashes do not match", which does not name either variable.
if [[ "${SIMULATED_TEE:-true}" == "false" && "${MODE:-1}" != "0" ]]; then
  echo "error: SIMULATED_TEE=false requires MODE=0 (production attestation)." >&2
  exit 1
fi
if [[ "${SIMULATED_TEE:-true}" == "true" && "${MODE:-1}" != "1" ]]; then
  echo "error: SIMULATED_TEE=true requires MODE=1 (simulated attestation)." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Reproducible build stamp
# ---------------------------------------------------------------------------
#
# Derived from the last commit so the same source always produces the same hash. Falling back to
# the current time would make every build produce a different code hash, which would mean
# re-registering the TEE after every rebuild and would make the published hash unverifiable.

if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
  if git rev-parse --git-dir >/dev/null 2>&1; then
    SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)
    export SOURCE_DATE_EPOCH
  else
    echo "error: not a git repository and SOURCE_DATE_EPOCH is unset." >&2
    echo "  A reproducible build needs a fixed timestamp. Set it explicitly:" >&2
    echo "    SOURCE_DATE_EPOCH=\$(date -d 2026-01-01 +%s) ./scripts/start-services.sh" >&2
    exit 1
  fi
fi

if git rev-parse --git-dir >/dev/null 2>&1 && ! git diff-index --quiet HEAD -- 2>/dev/null; then
  echo "warning: the working tree is dirty." >&2
  echo "  SOURCE_DATE_EPOCH comes from the last commit, but the build will include your" >&2
  echo "  uncommitted changes — so the resulting code hash is not reproducible from any" >&2
  echo "  published commit. Commit before building for a real deployment." >&2
  echo >&2
fi

echo "=== Fidensur start-services ==="
echo "  SOURCE_DATE_EPOCH: $SOURCE_DATE_EPOCH  ($(date -u -d "@$SOURCE_DATE_EPOCH" 2>/dev/null || echo 'n/a'))"
echo "  MODE:              ${MODE:-1}  ($([[ "${MODE:-1}" == "0" ]] && echo 'production attestation' || echo 'SIMULATED attestation'))"
echo "  EXTENSION_ID:      ${EXTENSION_ID:-unset}"
echo "  FIDENSUR_CONTRACT: ${FIDENSUR_CONTRACT:-unset}"
echo "  EXT_PROXY_URL:     $EXT_PROXY_URL"
echo

docker compose up -d --build

echo
echo "--- waiting for the extension proxy on localhost:6674 ---"

for _ in $(seq 1 60); do
  if curl -sf http://localhost:6674/info >/dev/null 2>&1; then
    echo "  proxy is up"
    break
  fi
  sleep 2
done

if ! curl -sf http://localhost:6674/info >/dev/null 2>&1; then
  echo "error: the proxy did not come up within 120s." >&2
  echo "  docker compose logs ext-proxy" >&2
  echo "  A DB sync error here usually means missing Coston2 indexer credentials in" >&2
  echo "  config/proxy/extension_proxy.docker.toml — see docs/fcc-research.md §9.3." >&2
  exit 1
fi

echo
echo "--- attestation report ---"
curl -s http://localhost:6674/info | (command -v jq >/dev/null && jq '.machineData' || cat)

echo
echo "Check that machineData matches config/extension.env, then run ./scripts/post-build.sh"
echo
echo "For a real deployment, confirm:"
echo "  platform  starts with 0x4743505f414d445f534556  (GCP_AMD_SEV)"
echo "  codeHash  is a measured hash, NOT the simulated 0x194844cf..."
