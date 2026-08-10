# tee-proxy — built from source, because Flare does not publish it as an image.
#
# The Flare scaffold's docker-compose refers to `${REGISTRY:-local}/tee-proxy`, which resolves to
# `local/tee-proxy` — an image that exists only if you built it yourself. There is no public
# registry to pull it from, so any deployment has to build it. This file does that, and CI
# publishes the result to ghcr so a small host can pull instead of compile.
#
# ## Version
#
# Pinned to a release tag rather than a branch, so a rebuild produces the same proxy. The scaffold
# pins v0.0.18; this is v0.0.21, the latest release at time of writing.
#
# The Coston2 hackathon guidance says to run tee-node and tee-proxy "on develop", and tee-node is
# pinned to v0.0.24 in extension/go.mod for that reason. If a proxy fix lands on develop that has
# not been tagged, override:
#
#   docker build --build-arg TEE_PROXY_VERSION=develop -f proxy/Dockerfile proxy/
#
# A branch is a moving target, so it is not the default — but it is one flag away when needed.

ARG TEE_PROXY_VERSION=v0.0.21

FROM golang:1.25.1-alpine AS builder

RUN apk add --no-cache git

ARG TEE_PROXY_VERSION
ARG SOURCE_DATE_EPOCH

WORKDIR /app

# tee-proxy's own go.mod transitively pins the matching tee-node and go-flare-common line, so
# building it this way pulls the node code the proxy expects. No separate clone or replace
# directive is needed.
RUN git clone --depth 1 --branch ${TEE_PROXY_VERSION} https://github.com/flare-foundation/tee-proxy.git

WORKDIR /app/tee-proxy
RUN go mod download

# Same determinism flags as the extension image. This binary is not attested, so its hash is not
# security-critical — but a reproducible proxy build costs nothing and means a rebuild does not
# produce a gratuitously different image.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOFLAGS="-buildvcs=false" \
    go build -trimpath -ldflags="-buildid= -s -w" -o main ./cmd/proxy

RUN if [ "${SOURCE_DATE_EPOCH:-0}" -gt 0 ] 2>/dev/null; then \
      find /app/tee-proxy/main -exec touch -h -d @${SOURCE_DATE_EPOCH} {} +; \
    fi

FROM alpine:3.21

WORKDIR /app

COPY --from=builder /app/tee-proxy/main .
# Baked as a fallback only. docker-compose mounts the real config over this path, carrying the
# indexer credentials — which is why those never enter the image.
COPY --from=builder /app/tee-proxy/config.example.toml ./config/config.toml

RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

# 6663 internal (extension container to proxy), 6664 external (data providers reach this one).
EXPOSE 6663 6664

CMD ["./main"]
