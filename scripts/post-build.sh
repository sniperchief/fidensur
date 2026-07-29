#!/usr/bin/env bash
#
# Phase 3 of the deployment lifecycle: whitelist the code hash and register the TEE machine.
#
# ---------------------------------------------------------------------------
# READ THIS FIRST
# ---------------------------------------------------------------------------
#
# This script does NOT reimplement Flare's TEE registration. It delegates to the official tools in
# flare-foundation/fce-extension-scaffold, and that is a deliberate choice rather than an omission.
#
# The three steps below — allow-tee-version, set-governance, register-tee — involve an attestation
# challenge/response handshake with Flare's FTDC providers whose wire protocol is not documented
# anywhere public. Reimplementing it from a reading of the scaffold's source would produce code
# that looks right, cannot be tested without a live Confidential Space VM, and would fail in ways
# that are hard to distinguish from a genuine attestation problem. Pointing at the tool that is
# known to work is more useful than a plausible-looking guess.
#
# What this script does do: verify every precondition that is checkable locally, so the common
# failures surface here with a readable message rather than as an opaque on-chain revert.
#
# Usage:
#   git clone https://github.com/flare-foundation/fce-extension-scaffold.git ../fce-extension-scaffold
#   ./scripts/post-build.sh

set -euo pipefail

cd "$(dirname "$0")/.."

SCAFFOLD="${FCE_SCAFFOLD_PATH:-../fce-extension-scaffold}"

[[ -f .env ]] || { echo "error: .env not found." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

[[ -f config/extension.env ]] || {
  echo "error: config/extension.env not found — run ./scripts/pre-build.sh first." >&2; exit 1;
}
# shellcheck disable=SC1091
set -a; source config/extension.env; set +a

echo "=== Fidensur post-build preflight ==="
echo

fail=0

# --- 1. Is the proxy reachable? --------------------------------------------

echo "--- proxy ---"
if ! INFO=$(curl -sf http://localhost:6674/info 2>/dev/null); then
  echo "  FAIL  the extension proxy is not responding on localhost:6674" >&2
  echo "        run ./scripts/start-services.sh, then check: docker compose logs ext-proxy" >&2
  fail=1
else
  echo "  ok    proxy responding"

  # --- 2. Does the reported extension ID match what we registered? ---------
  #
  # A mismatch here is the usual cause of MachineManager.TooMany() during register-tee, and the
  # on-chain error does not mention either value.
  REPORTED_ID=$(echo "$INFO" | grep -o '"extensionId":[^,}]*' | head -1 | cut -d: -f2 | tr -d ' "')
  if [[ -n "$REPORTED_ID" && -n "${EXTENSION_ID:-}" && "$REPORTED_ID" != "$EXTENSION_ID" ]]; then
    echo "  FAIL  proxy reports extension ID $REPORTED_ID, config/extension.env says $EXTENSION_ID" >&2
    echo "        the container is serving a different extension — restart the stack" >&2
    fail=1
  else
    echo "  ok    extension ID matches ($EXTENSION_ID)"
  fi

  # --- 3. Is the attestation real, and does it match the configuration? ----
  CODE_HASH=$(echo "$INFO" | grep -o '"codeHash":"[^"]*"' | cut -d'"' -f4)
  PLATFORM=$(echo "$INFO" | grep -o '"platform":"[^"]*"' | cut -d'"' -f4)

  echo "  info  codeHash: ${CODE_HASH:-unknown}"
  echo "  info  platform: ${PLATFORM:-unknown}"

  if [[ "$CODE_HASH" == 0x194844cf* ]]; then
    if [[ "${SIMULATED_TEE:-true}" == "false" ]]; then
      echo "  FAIL  simulated code hash, but SIMULATED_TEE=false" >&2
      echo "        the image must be built with MODE=0 for a real deployment" >&2
      fail=1
    else
      echo "  warn  SIMULATED attestation — Flare's data providers will reject results from this" >&2
      echo "        machine, and the verification explorer will mark the round unverifiable." >&2
    fi
  elif [[ "$PLATFORM" == 0x4743505f414d445f534556* ]]; then
    echo "  ok    real GCP_AMD_SEV attestation"
  fi
fi

# --- 4. Is the TEE address set on the contract? ----------------------------
#
# Not needed by post-build itself, but finalizeRound reverts with TeeAddressNotSet until it is, so
# flagging it here saves discovering it during the first round.

echo
echo "--- contract ---"
if [[ -n "${FIDENSUR_CONTRACT:-}" && -n "${CHAIN_URL:-}" ]]; then
  TEE_ADDR=$(cast call "$FIDENSUR_CONTRACT" "teeAddress()(address)" --rpc-url "$CHAIN_URL" 2>/dev/null || echo "")
  if [[ "$TEE_ADDR" == "0x0000000000000000000000000000000000000000" || -z "$TEE_ADDR" ]]; then
    echo "  warn  teeAddress is not set yet — do this after register-tee succeeds:"
    echo "          cast send $FIDENSUR_CONTRACT 'setTeeAddress(address)' <TEE_MACHINE_ADDRESS> \\"
    echo "            --rpc-url $CHAIN_URL --private-key \$DEPLOYMENT_PRIVATE_KEY"
  else
    echo "  ok    teeAddress: $TEE_ADDR"
  fi
fi

echo

if (( fail )); then
  echo "Preflight failed. Fix the above before registering." >&2
  exit 1
fi

# --- 5. Delegate to the official tools --------------------------------------

echo "=== TEE registration ==="
echo

if [[ ! -d "$SCAFFOLD/tools" ]]; then
  cat <<EOF
The Flare scaffold is not at: $SCAFFOLD

Clone it, or set FCE_SCAFFOLD_PATH:

  git clone https://github.com/flare-foundation/fce-extension-scaffold.git $SCAFFOLD

Then run these three, in order, from \$SCAFFOLD with this project's .env values:

  1. allow-tee-version   whitelists the measured code hash on-chain
  2. set-governance      registers the TEE governance signer set and threshold
  3. register-tee -command rRap
                         registers the machine, issues a FRESH attestation challenge,
                         runs the FTDC check, and promotes it to production

Notes that will save you an hour:

  * The capital R in -command rRap issues a fresh challenge. Without it, a re-run fails with
    Verification.ChallengeExpired.
  * GOVERNANCE_SIGNERS / GOVERNANCE_THRESHOLD must be identical to what the extension-tee
    container was given, or registration reverts with InvalidGovernanceHash. Leaving both unset
    on each side gives the matching deployer-only default.
  * If registration times out, Coston2's relay providers may be idle. Try:
    docker compose restart ext-proxy

Afterwards, point the contract at the registered machine:

  cast send ${FIDENSUR_CONTRACT:-<contract>} 'setTeeAddress(address)' <TEE_MACHINE_ADDRESS> \\
    --rpc-url ${CHAIN_URL:-<rpc>} --private-key \$DEPLOYMENT_PRIVATE_KEY

Then run ./scripts/test.sh
EOF
  exit 1
fi

echo "Found the scaffold at $SCAFFOLD."
echo "Run its registration tools with this project's .env, then set teeAddress as shown above."
echo
echo "This script stops here deliberately: it will not drive attestation on your behalf with"
echo "arguments it cannot validate. See the header comment for why."
