# Production image for the Sherlock API service: the GitHub App webhook
# receiver (probot) that authorizes "/sherlock investigate" commands and
# enqueues investigation jobs, plus the health/readiness server. It holds NO
# investigation runtime (no Docker socket, git clones, or Playwright): the
# separate worker image (Dockerfile.worker) does that. Secrets are provided at
# runtime (APP_ID / PRIVATE_KEY[_PATH] / WEBHOOK_SECRET / ANTHROPIC_API_KEY /
# REDIS_URL), never baked in.
#
# `npm start` runs two processes via concurrently:
#   - probot webhook receiver  -> PORT          (public GitHub webhook ingress)
#   - health/readiness server  -> BACKEND_PORT  (GET /healthz, /readyz)

FROM node:22-bookworm-slim
WORKDIR /usr/src/app

# Full install so tsc (a dev dependency) can compile during the build; pruned
# to production dependencies afterwards. lib/ is gitignored, so a clean
# checkout has no compiled JS and must build here.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY backend ./backend
COPY src ./src
RUN npm run build

# Drop build-only dependencies (concurrently, probot, and the runtime deps
# remain; typescript/vitest/etc. are removed).
RUN npm prune --omit=dev && npm cache clean --force

ENV NODE_ENV=production
# Webhook ingress and the health/readiness server. Override at runtime if the
# defaults collide with a platform-assigned port.
ENV PORT=3000
ENV BACKEND_PORT=4000
EXPOSE 3000 4000

CMD [ "npm", "start" ]
