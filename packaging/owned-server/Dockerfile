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
