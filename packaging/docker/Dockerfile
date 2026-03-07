FROM node:22-bookworm-slim

ARG VESLO_ORCHESTRATOR_VERSION=0.11.22

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tar \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "veslo-orchestrator@${VESLO_ORCHESTRATOR_VERSION}"

# Persistent directories (mount volumes here on PaaS/SSH).
ENV VESLO_DATA_DIR=/data/veslo-orchestrator
ENV VESLO_SIDECAR_DIR=/data/sidecars

# The workspace is mounted from the host/volume.
ENV VESLO_WORKSPACE=/workspace

# Veslo host contract surface.
EXPOSE 8787

# Optional: veslo-code-router health (only relevant if you enable the router).
EXPOSE 3005

VOLUME ["/workspace", "/data"]

# Defaults:
# - Veslo server is public (0.0.0.0:8787)
# - OpenCode stays internal (127.0.0.1:4096)
# - Veslo server proxies OpenCode via localhost
# - OpenCode Router disabled by default
CMD [
  "veslo",
  "serve",
  "--workspace", "/workspace",
  "--veslo-host", "0.0.0.0",
  "--veslo-port", "8787",
  "--opencode-host", "127.0.0.1",
  "--opencode-port", "4096",
  "--connect-host", "127.0.0.1",
  "--cors", "*",
  "--approval", "manual",
  "--no-veslo-code-router"
]
