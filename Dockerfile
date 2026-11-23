# syntax=docker/dockerfile:1

# Host-agnostic image: published to ghcr.io by .github/workflows/docker.yml, built by
# Railway from railway.json, runs anywhere Docker does. Data lives in /data.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/mobile/package.json packages/mobile/
RUN pnpm install --frozen-lockfile --filter @unresub/server... --filter @unresub/web...
COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/web packages/web
RUN pnpm --filter @unresub/web build && pnpm --filter @unresub/server build

FROM node:22-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="UnReSub" \
      org.opencontainers.image.description="Self-hosted subscription tracker for monobank" \
      org.opencontainers.image.source="https://github.com/zgv2-dev/unresub" \
      org.opencontainers.image.version="$VERSION"
# Everything lives in /data: core.db (accounts), users/<id>.db (each user's bank data),
# secret.key (generated on first run unless UNRESUB_SECRET_KEY is set). Mount a volume there.
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    UNRESUB_VERSION=$VERSION
WORKDIR /app
# index.mjs finds the UI at ../../web/dist, so keep the same layout.
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
# Runs as root on purpose: Railway mounts volumes root-owned, and a non-root
# user couldn't write the SQLite file there without extra settings.
RUN mkdir /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/server/dist/index.mjs"]
