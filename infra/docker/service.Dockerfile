# syntax=docker/dockerfile:1.7
# Builds any backend app of the monorepo: docker build --build-arg APP=identity-service ...
ARG NODE_VERSION=22.22.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json vitest.shared.ts ./
COPY packages packages
COPY apps apps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
ARG APP
RUN pnpm exec turbo run build --filter=@a5/${APP}...
# Self-contained production deployment of the app and its workspace dependencies.
RUN pnpm --filter @a5/${APP} deploy --prod --legacy /out

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP
# Media processing needs ffmpeg; other services stay slim.
ARG WITH_FFMPEG=false
RUN if [ "$WITH_FFMPEG" = "true" ]; then apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*; fi
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000-4090
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
