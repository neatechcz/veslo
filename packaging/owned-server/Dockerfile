# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base

WORKDIR /app

ENV CI=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@10.27.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY patches ./patches
COPY packages ./packages
COPY services ./services

RUN pnpm install --frozen-lockfile

FROM base AS den

RUN pnpm --filter @neatech/den build

ENV NODE_ENV=production
EXPOSE 8788

CMD ["pnpm", "--filter", "@neatech/den", "start"]

FROM base AS ai-gateway

RUN pnpm --filter @neatech/ai-gateway build

ENV NODE_ENV=production
EXPOSE 4034

CMD ["pnpm", "--filter", "@neatech/ai-gateway", "start"]

FROM base AS worker-manager

RUN pnpm --filter @neatech/worker-manager build

ENV NODE_ENV=production
EXPOSE 8790

CMD ["pnpm", "--filter", "@neatech/worker-manager", "start"]

FROM base AS worker-runtime

ARG BUN_VERSION=1.3.6

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g bun@${BUN_VERSION}

RUN pnpm --filter veslo-server build \
  && pnpm --filter veslo-orchestrator build

RUN printf '%s\n' '#!/bin/sh' 'exec bun /app/packages/orchestrator/dist/cli.js "$@"' > /usr/local/bin/veslo \
  && chmod +x /usr/local/bin/veslo

ENV NODE_ENV=production
EXPOSE 8787

CMD ["sh", "-lc", "mkdir -p /workspace && veslo serve --workspace /workspace --veslo-host 0.0.0.0 --veslo-port 8787 --opencode-host 127.0.0.1 --opencode-port 4096 --connect-host 127.0.0.1 --cors '*' --approval manual --allow-external --veslo-server-bin /app/packages/server/dist/cli.js --no-veslo-code-router --verbose"]

FROM base AS web

ARG DEN_API_BASE=https://api.veslo.work
ARG DEN_AUTH_ORIGIN=https://api.veslo.work
ARG NEXT_PUBLIC_OPENWORK_APP_CONNECT_URL=
ARG NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL=https://app.veslo.work
ARG NEXT_PUBLIC_VESLO_APP_CONNECT_URL=
ARG NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL=https://app.veslo.work
ARG NEXT_PUBLIC_POSTHOG_KEY=
ARG NEXT_PUBLIC_POSTHOG_API_KEY=
ARG NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com

ENV DEN_API_BASE=${DEN_API_BASE}
ENV DEN_AUTH_ORIGIN=${DEN_AUTH_ORIGIN}
ENV NEXT_PUBLIC_OPENWORK_APP_CONNECT_URL=${NEXT_PUBLIC_OPENWORK_APP_CONNECT_URL}
ENV NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL=${NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL}
ENV NEXT_PUBLIC_VESLO_APP_CONNECT_URL=${NEXT_PUBLIC_VESLO_APP_CONNECT_URL}
ENV NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL=${NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL}
ENV NEXT_PUBLIC_POSTHOG_KEY=${NEXT_PUBLIC_POSTHOG_KEY}
ENV NEXT_PUBLIC_POSTHOG_API_KEY=${NEXT_PUBLIC_POSTHOG_API_KEY}
ENV NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST}

RUN pnpm --filter @neatech/veslo-web build

ENV NODE_ENV=production
EXPOSE 3005

CMD ["pnpm", "--filter", "@neatech/veslo-web", "start"]
