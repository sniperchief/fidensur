# Fidensur allocation engine — reproducible TEE image.
#
# The code hash of this image is what gets whitelisted on-chain, and it is what a public verifier
# checks when they ask "which program produced this allocation?". So build determinism here is a
# security property, not a nicety: if two people building the same source get different hashes,
# Fidensur's central claim — rebuild the published source, get the attested hash — is false.
#
# Go on distroless is the only language path in the FCC scaffold that is bit-for-bit reproducible
# *across machines*. Python and TypeScript images embed build-host paths in their dependency trees
# and reach same-machine determinism at best. That is why the engine is written in Go.
#
# Build with:
#   docker build --build-arg SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) -t fidensur-extension .

# Pinned by digest, not by tag: `golang:1.25.1-trixie` is a moving target and a re-tag would
# silently change the code hash.
FROM golang:1.25.1-trixie@sha256:ff83f3762390c2cccb53618ccc18af23e556aff9b1db4428637e9f63287c8171 AS builder

# Commit timestamp, threaded through the build to clamp mtimes and normalize embedded dates.
ARG SOURCE_DATE_EPOCH
ENV SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH

WORKDIR /build

# apt normally resolves to whatever the mirror serves at build time, so two builds days apart
# install different bytes. Redirect apt at snapshot.debian.org keyed on SOURCE_DATE_EPOCH so every
# build installs the exact package set that existed at that instant.
# Taken from https://github.com/reproducible-containers/repro-sources-list.sh
RUN \
  --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  if [ "${SOURCE_DATE_EPOCH:-0}" -gt 0 ] 2>/dev/null; then \
    snapshot="$(/bin/bash -euc "printf \"%(%Y%m%dT%H%M%SZ)T\n\" \"${SOURCE_DATE_EPOCH}\"")" && \
    sed -i -e '/Types: deb/ a\Snapshot: true' /etc/apt/sources.list.d/debian.sources && \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' >/etc/apt/apt.conf.d/keep-cache && \
    apt-get install --update --snapshot "${snapshot}" -o Acquire::Check-Valid-Until=false \
      -o Acquire::https::Verify-Peer=false -y ca-certificates && \
    rm -rf /var/log/* /var/cache/ldconfig/aux-cache; \
  else \
    apt-get update && apt-get install -y ca-certificates && \
    rm -rf /var/log/* /var/cache/ldconfig/aux-cache; \
  fi

# Manifests first, so the dependency download layer is cached independently of source edits.
# go.sum pins every dependency by hash; `go mod verify` checks them before anything is compiled.
COPY --chmod=644 --chown=0:0 go.mod go.sum ./
RUN go mod download
RUN go mod verify

COPY --chmod=644 --chown=0:0 cmd/ ./cmd/
COPY --chmod=644 --chown=0:0 internal/ ./internal/
COPY --chmod=644 --chown=0:0 pkg/ ./pkg/

# Each flag removes a source of build-to-build variance:
#   -trimpath        strips build-host paths from the binary
#   -buildid=        clears Go's non-deterministic build id
#   -s -w            drop symbol and DWARF tables, which carry build-time data
#   -buildvcs=false  omits embedded VCS metadata (branch, commit, dirty flag)
#   CGO_ENABLED=0    static binary, so no link-time libc variance
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOFLAGS="-buildvcs=false" \
    go build -trimpath -ldflags="-buildid= -s -w" -o /app/fidensur-extension ./cmd/docker

# BuildKit's rewrite-timestamp only clamps mtimes *downward* (moby/buildkit#3180), leaving files
# older than SOURCE_DATE_EPOCH at their original nondeterministic mtime. Touch everything so
# timestamps are normalized in both directions.
RUN if [ "${SOURCE_DATE_EPOCH:-0}" -gt 0 ] 2>/dev/null; then \
      find /app -exec touch -h -d @${SOURCE_DATE_EPOCH} {} +; \
    fi

# Empty base: nothing outside these explicit COPYs reaches the final image, so the measured hash
# covers exactly the bytes we intended and nothing the builder happened to leave behind.
FROM gcr.io/distroless/static

WORKDIR /app

# TLS trust store for outbound HTTPS. chmod/chown are re-applied on each COPY so file metadata is
# pinned here rather than inherited from whatever the builder stage produced.
COPY --chmod=644 --chown=65532:65532 --from=builder \
     /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chmod=755 --chown=65532:65532 --from=builder \
     /app/fidensur-extension /app/fidensur-extension

# MODE=1 is SIMULATED attestation, for local development against the devnet.
#
# A real Confidential Space deploy MUST build with MODE=0 — FTDC rejects simulated attestation, and
# a mismatch between this and SIMULATED_TEE surfaces as "code hashes do not match". Compose
# overrides it via MODE=${MODE:-1}.
ENV MODE=1 CONFIG_PORT=5501 SIGN_PORT=7701 EXTENSION_PORT=7702

# Matches tee-node. The TEE is the isolation boundary; in-container user separation adds nothing.
USER 0:0

# Required. Without this label a GCP Confidential Space VM rejects operator env overrides *at
# attestation time*, and whatever was baked in at build becomes final — including EXTENSION_ID and
# PROXY_URL, which are not known until after the image exists. The failure appears at attestation
# rather than at build, which makes it unusually annoying to diagnose.
#
# FIDENSUR_CONTRACT is in the list because the deployment address is only known after pre-build
# deploys the contract, which happens after this image is built.
LABEL "tee.launch_policy.allow_env_override"="LOG_LEVEL,PROXY_URL,INITIAL_OWNER,EXTENSION_ID,CHAIN_URL,MODE,CONFIG_PORT,SIGN_PORT,EXTENSION_PORT,FIDENSUR_CONTRACT"

EXPOSE 5501 7701 7702

CMD ["/app/fidensur-extension"]
