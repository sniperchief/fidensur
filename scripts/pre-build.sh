#!/usr/bin/env bash
#
# Phase 1 of the deployment lifecycle: deploy Fidensur.sol and register it as an FCC extension.
#
# Order matters and is not arbitrary. The registry binds an extension to one InstructionSender
# address, so the contract must exist before registration; and the contract discovers its own
# extension ID by scanning the registry, so registration must happen before setExtensionId().
# Hence deploy → register → setExtensionId, in that order, in this script.
#
# Writes config/extension.env with EXTENSION_ID, INSTRUCTION_SENDER and FIDENSUR_CONTRACT — the
# values docker-compose and post-build both read.
#
# Usage:
#   cp .env.example .env && $EDITOR .env
#   ./scripts/pre-build.sh [--force]

set -euo pipefail

cd "$(dirname "$0")/.."

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

[[ -f .env ]] || { echo "error: .env not found. Copy .env.example and fill it in." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

: "${CHAIN_URL:?CHAIN_URL must be set in .env}"
: "${DEPLOYMENT_PRIVATE_KEY:?DEPLOYMENT_PRIVATE_KEY must be set in .env}"
: "${INITIAL_OWNER:?INITIAL_OWNER must be set in .env}"
: "${TEE_MANAGER_ADDRESS:?TEE_MANAGER_ADDRESS must be set in .env}"

EXTENSION_ENV="config/extension.env"

# Re-running would deploy a *second* contract and register a *second* extension ID, which then
# disagrees with any TEE machine already registered under the first — the on-chain symptom is
# MachineManager.TooMany(), a long way from the cause. On-chain state cannot be rolled back, so
# refusing here is the only way to make the mistake recoverable.
if [[ -f "$EXTENSION_ENV" && $FORCE -eq 0 ]]; then
  echo "error: $EXTENSION_ENV already exists — this extension is already deployed." >&2
  echo "" >&2
  echo "  Current values:" >&2
  sed 's/^/    /' "$EXTENSION_ENV" >&2
  echo "" >&2
  echo "  To re-run only registration, delete the file first." >&2
  echo "  To deploy a genuinely new extension, pass --force — but read the warning in" >&2
  echo "  docs/fcc-research.md §9.4 about MachineManager.TooMany() before you do." >&2
  exit 1
fi

mkdir -p config

echo "=== Fidensur pre-build ==="
echo "  chain:        $CHAIN_URL"
echo "  TEE manager:  $TEE_MANAGER_ADDRESS"
echo "  owner:        $INITIAL_OWNER"
echo

# ---------------------------------------------------------------------------
# Step 1 — deploy Fidensur.sol
# ---------------------------------------------------------------------------
#
# Both registry constructor arguments are the same FlareTeeManager diamond address:
# ITeeExtensionRegistry and ITeeMachineRegistry are two facets of one contract.

echo "--- Step 1/3: deploying Fidensur.sol ---"

# Reuse an already-deployed contract when one is supplied.
#
# Deployment is the only irreversible step here, and steps 2 and 3 are the ones that tend to need
# retrying. Without this, a failure in registration would force a fresh deploy — a second contract,
# a second extension ID, and a MachineManager.TooMany() much later, a long way from the cause.
if [[ -n "${FIDENSUR_ADDRESS:-}" ]]; then
  echo "  reusing existing deployment: $FIDENSUR_ADDRESS"
  echo "  (unset FIDENSUR_ADDRESS to deploy a new contract)"
  echo
else
  # Deliberately NOT --json.
  #
  # `forge create --broadcast --json` terminates the shell before any error handling can run: the
  # script died after printing "Step 1/3" with no output, no error, and no exit status to inspect.
  # The plain output is a stable two-line format that greps cleanly, so the JSON buys nothing.
  #
  # stdout and stderr are captured together and the exit code handled by hand, because forge
  # reports failures on stdout — which command substitution would otherwise swallow entirely.
  set +e
  DEPLOY_OUTPUT=$(forge create contracts/Fidensur.sol:Fidensur \
    --rpc-url "$CHAIN_URL" \
    --private-key "$DEPLOYMENT_PRIVATE_KEY" \
    --broadcast \
    --constructor-args "$TEE_MANAGER_ADDRESS" "$TEE_MANAGER_ADDRESS" "$INITIAL_OWNER" 2>&1)
  DEPLOY_RC=$?
  set -e

  echo "$DEPLOY_OUTPUT"

  if [[ $DEPLOY_RC -ne 0 ]]; then
    echo "" >&2
    echo "error: forge create failed (exit $DEPLOY_RC)." >&2
    echo "Common causes:" >&2
    echo "  * DEPLOYMENT_PRIVATE_KEY malformed — must be 64 hex chars with no 0x prefix" >&2
    echo "  * insufficient C2FLR — cast balance \$INITIAL_OWNER --rpc-url \$CHAIN_URL" >&2
    echo "  * contracts do not compile — forge build" >&2
    exit 1
  fi

  FIDENSUR_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' | awk '{print $3}')

  if [[ -z "$FIDENSUR_ADDRESS" ]]; then
    echo "error: forge create reported success but no 'Deployed to:' line was found above." >&2
    exit 1
  fi

  echo
  echo "  deployed to: $FIDENSUR_ADDRESS"
  echo
fi

# ---------------------------------------------------------------------------
# Step 2 — register as an FCC extension
# ---------------------------------------------------------------------------

echo "--- Step 2/3: registering the extension ---"

(
  cd extension
  DEPLOYMENT_PRIVATE_KEY="$DEPLOYMENT_PRIVATE_KEY" \
  go run ./tools/cmd/register-extension \
    -rpc "$CHAIN_URL" \
    -registry "$TEE_MANAGER_ADDRESS" \
    -sender "$FIDENSUR_ADDRESS" \
    -out "../$EXTENSION_ENV"
)

echo

# ---------------------------------------------------------------------------
# Step 3 — let the contract discover its extension ID
# ---------------------------------------------------------------------------
#
# Permissionless and set-once. It scans the registry from 0x10000 upward — public extension IDs
# start there, and everything below is reserved for system extensions.

echo "--- Step 3/3: setExtensionId() ---"

cast send "$FIDENSUR_ADDRESS" "setExtensionId()" \
  --rpc-url "$CHAIN_URL" \
  --private-key "$DEPLOYMENT_PRIVATE_KEY" \
  >/dev/null

ON_CHAIN_ID=$(cast call "$FIDENSUR_ADDRESS" "extensionId()(uint256)" --rpc-url "$CHAIN_URL")
echo "  contract reports extension ID: $ON_CHAIN_ID"

# The contract's own scan and the registration event must agree. If they do not, something else
# was registered against this address and every later step would be operating on the wrong ID.
RECORDED_ID=$(grep '^EXTENSION_ID=' "$EXTENSION_ENV" | cut -d= -f2)
if [[ "$ON_CHAIN_ID" != "$RECORDED_ID" ]]; then
  echo "error: extension ID mismatch — contract says $ON_CHAIN_ID, registration recorded $RECORDED_ID" >&2
  exit 1
fi

echo
echo "=== pre-build complete ==="
sed 's/^/  /' "$EXTENSION_ENV"
echo
echo "Next:"
echo "  1. Start an HTTPS tunnel to port 6674 and set EXT_PROXY_URL in .env."
echo "     It must be set BEFORE start-services — post-build and test both read it."
echo "  2. ./scripts/start-services.sh"
echo "  3. ./scripts/post-build.sh"
