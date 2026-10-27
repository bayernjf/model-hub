# syntax=docker/dockerfile:1

# ---- builder: install full deps and compile all workspaces ----
FROM node:22-slim AS builder
WORKDIR /app

# Copy workspace manifests first so dependency installation is cached
# independently from source changes.
COPY package.json package-lock.json ./
COPY apps/hub/package.json apps/hub/package.json
COPY packages/model-kit/package.json packages/model-kit/package.json
RUN npm ci

# TypeScript configs and sources.
COPY tsconfig.base.json ./
COPY apps/hub/tsconfig.json apps/hub/tsconfig.build.json apps/hub/
COPY packages/model-kit/tsconfig.json packages/model-kit/tsconfig.build.json packages/model-kit/
COPY apps/hub/src apps/hub/src
COPY packages/model-kit/src packages/model-kit/src
RUN npm run build

# ---- runner: production dependencies only, non-root ----
FROM node:22-slim AS runner
ENV NODE_ENV=production \
    HUB_PORT=8791 \
    HUB_DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/hub/package.json apps/hub/package.json
COPY packages/model-kit/package.json packages/model-kit/package.json
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder --chown=node:node /app/apps/hub/dist apps/hub/dist
COPY --from=builder --chown=node:node /app/packages/model-kit/dist packages/model-kit/dist

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8791
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8791/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
# node:sqlite is still behind the experimental flag on Node 22.
CMD ["node", "--experimental-sqlite", "apps/hub/dist/server.js"]
