# Sherlock deployment

This is the reference deployment for Sherlock: a stateless **api** service, a
separate **worker** service, and a **redis** queue, wired together by
[`docker-compose.prod.yml`](../docker-compose.prod.yml) for a single host
(staging or a small production install). It is designed to grow into the
endgoal — horizontally scaled workers, managed Redis, durable object storage,
and a dashboard reading Supabase — without re-architecting.

For worker runtime internals (the Docker-socket requirement, sibling-container
path alignment, Graphify packaging, the state store), see
[production-worker.md](production-worker.md). This document is the operator's
guide: what to run, how, and how to keep it healthy.

## Architecture

```
                          GitHub  ──webhook──►  (TLS reverse proxy :443)
                                                        │  /api/github/webhooks
                                                        ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │  api  (Dockerfile, `npm start`)                       stateless       │
   │   • probot webhook receiver        :3000  ← public ingress            │
   │   • health / readiness server      :4000  ← GET /healthz, /readyz     │
   │   authorizes "/sherlock investigate", enqueues a job. No Docker,      │
   │   no clones, no browser. Safe to run 1..N replicas.                   │
   └───────────────┬─────────────────────────────────────────────────────┘
                   │ enqueue (non-secret payload)
                   ▼
   ┌─────────────────────────┐        ┌──────────────────────────────────┐
   │  redis  (BullMQ queue)  │◄──────►│  worker  (Dockerfile.worker)      │
   │  append-only volume     │  pull  │   clone → sandbox → reproduce →   │
   │  + webhook-command dedup│        │   fix → verify → open PR          │
   └─────────────────────────┘        │   • controls HOST Docker daemon   │
                                       │     (/var/run/docker.sock)        │
   ┌─────────────────────────┐        │   • Playwright Chromium           │
   │  Supabase / Postgres    │◄───────┤   • writes redacted state rows    │
   │  investigation_states   │  state │   • artifacts + repo memory vols  │
   │  (RLS on, service role) │        └──────────────────────────────────┘
   └─────────────────────────┘                    │ docker run (siblings)
        ▲ dashboard reads later                    ▼
                                          target app + validation/regression
                                          containers (per investigation)
```

Secrets flow only through environment/mounted files into the api and worker.
They are **never** placed on the queue: the job payload is non-secret, and the
worker mints its own short-lived GitHub installation tokens from the App key.

## Required services

| Service | Image / source | Role | State |
| --- | --- | --- | --- |
| `api` | `Dockerfile` | GitHub webhook ingress + health server | stateless |
| `worker` | `Dockerfile.worker` | investigation pipeline consumer | artifacts + repo memory on volumes |
| `redis` | `redis:7-alpine` | BullMQ queue + command dedup | append-only volume |
| Supabase/Postgres | external | investigation state store | managed by Supabase |
| Docker daemon (host) | host | runs target/validation/regression containers | — |

Host prerequisites: Docker Engine + Compose v2, and a `/var/tmp/sherlock`
(or `SHERLOCK_HOST_TMP`) directory the worker can use for clone workspaces.

## Required environment variables

Copy an example and fill it in on the host (never commit the result):

```sh
cp .env.production.example .env.production   # staging: .env.staging.example
```

This one file plays **two roles**, which is why every `docker compose` command
in this guide passes it twice, once per role:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml <command>
```

1. **Container environment** (`env_file:` in the compose file): the app
   variables in the table below, injected into both services.
2. **Compose interpolation** (`--env-file` on the CLI): the "Compose host
   settings" (`SHERLOCK_ENV_FILE`, `API_WEBHOOK_PORT`, `SHERLOCK_HOST_TMP`,
   `SHERLOCK_PRIVATE_KEY_FILE`) are resolved by the docker compose CLI when it
   *parses* the file — before any container exists — so `env_file:` alone
   cannot supply them. Omitting `--env-file` silently uses the production
   defaults for ports, the clone directory, and the private-key path.

Get in the habit of always passing `--env-file`; it is harmless for commands
that don't need interpolation (`logs`, `ps`) and prevents staging from ever
resolving production defaults. A shell alias keeps this readable:

```sh
alias sherlock-compose='docker compose --env-file .env.production -f docker-compose.prod.yml'
# staging host: alias sherlock-compose='docker compose --env-file .env.staging -f docker-compose.prod.yml'
```

Both services load this one file (`env_file`). Names by service:

| Variable | api | worker | Notes |
| --- | :-: | :-: | --- |
| `APP_ID` | ✓ | ✓ | GitHub App numeric id |
| `PRIVATE_KEY_PATH` **or** `PRIVATE_KEY` | ✓ | ✓ | App key; path is mounted as a Docker secret |
| `WEBHOOK_SECRET` | ✓ | | webhook signature verification (probot) |
| `ANTHROPIC_API_KEY` | ✓ | ✓ | plan/fix/regression generation |
| `ANTHROPIC_MODEL` | ✓ | ✓ | optional model override |
| `REDIS_URL` | ✓ | ✓ | `redis://redis:6379` for bundled Redis; **required in production** (readiness fails without it — the localhost fallback is always wrong in a container) |
| `SHERLOCK_STATE_STORE` | ✓ | ✓ | `supabase` for durable state |
| `SUPABASE_URL` | ✓ | ✓ | required when state store is `supabase` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | ✓ | **backend-only** secret; never ship to clients |
| `SHERLOCK_SANDBOX_NETWORK_POLICY` | | ✓ | `strict` (default) or `permissive` |
| `SHERLOCK_RUN_STARTUP_CHECKS` | | ✓ | set to `true` (compose does this) to fail fast |
| `WEBHOOK_PROXY_URL` | ✓ | | smee relay for non-public hosts; blank in prod |

`NODE_ENV`, `SHERLOCK_RUN_STARTUP_CHECKS`, and `TMPDIR` are set by the compose
file itself. Optional tuning (`INVESTIGATION_WORKER_CONCURRENCY`,
`SHERLOCK_TARGET_IMAGE`, timeouts) is listed in the example files.

The api will not report ready (`GET /readyz` → 503) until `APP_ID`,
`PRIVATE_KEY`/`PRIVATE_KEY_PATH`, `WEBHOOK_SECRET`, and `ANTHROPIC_API_KEY` are
present (plus `REDIS_URL` when `NODE_ENV=production`, and Supabase creds when
that store is selected). The worker refuses to consume jobs until
`npm run worker:check` passes (enforced at startup).

> **Health port is container-internal.** `/healthz` and `/readyz` are served
> on the backend health port (`BACKEND_PORT`, default 4000), which the compose
> file deliberately does **not** publish — only the webhook port (3000) is
> exposed, and that is the one your reverse proxy fronts. Probe readiness from
> inside the container (see [Verify](#first-deploy) below) or, if an external
> load balancer must reach it, publish it bound to loopback only by adding
> `- "127.0.0.1:4000:4000"` to the api service's `ports:` — never expose the
> health port to the public internet.

## First deploy

1. **Place the GitHub App private key** where the compose secret expects it
   (gitignored):

   ```sh
   mkdir -p secrets
   cp /path/to/your-app.private-key.pem secrets/github-app-private-key.pem
   chmod 400 secrets/github-app-private-key.pem
   ```

   (Or set `PRIVATE_KEY` inline in the env file and remove the `secrets:`
   blocks from the compose file.)

2. **Apply the Supabase migration** (creates `public.investigation_states`,
   RLS enabled with no policies):

   ```sh
   # Supabase CLI
   supabase db push
   # …or paste supabase/migrations/20260708000000_create_investigation_states.sql
   # into the Supabase SQL editor and run it.
   ```

   The table stores only the folded, redacted `InvestigationStateRecord` plus
   safe scalar columns — never issue/comment bodies, tokens, env, or raw
   webhook payloads. Do not add a public anon read policy; the dashboard will
   read through the backend service role or explicit scoped policies later.

3. **Prepare the worker clone directory** on the host (must be an identical
   path inside the container — see production-worker.md):

   ```sh
   sudo mkdir -p /var/tmp/sherlock
   ```

4. **Build and start** (note `--env-file` — see
   [Required environment variables](#required-environment-variables)):

   ```sh
   docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
   ```

   Staging uses the same compose file with its own env file, whose
   `SHERLOCK_ENV_FILE` and `SHERLOCK_PRIVATE_KEY_FILE` entries keep it off the
   production env file and production private key:

   ```sh
   docker compose --env-file .env.staging -f docker-compose.prod.yml up -d --build
   ```

5. **Verify** (readiness is probed from *inside* the container — the health
   port is not published):

   ```sh
   docker compose --env-file .env.production -f docker-compose.prod.yml ps
   # api readiness (container-internal port 4000)
   docker compose --env-file .env.production -f docker-compose.prod.yml exec api \
     node -e "fetch('http://127.0.0.1:4000/readyz').then(r=>r.text()).then(console.log)"
   # deep worker host check
   docker compose --env-file .env.production -f docker-compose.prod.yml exec worker npm run worker:check
   ```

## GitHub App webhook URL

Once the api is reachable over HTTPS, set the GitHub App's **Webhook URL** to:

```
https://<your-domain>/api/github/webhooks
```

`/api/github/webhooks` is probot's default path (override with `WEBHOOK_PATH`).
Set the App's **Webhook secret** to the same value as `WEBHOOK_SECRET`. Ensure
the App subscribes to **Issue comment** events and has repository
**Contents**, **Issues**, and **Pull requests** read/write permissions.

For a non-public staging host, set `WEBHOOK_PROXY_URL` to a smee.io channel
instead of exposing a URL.

## Operating

All commands below use the production env file; on a staging host substitute
`--env-file .env.staging` (or use the `sherlock-compose` alias from
[Required environment variables](#required-environment-variables)).

**Logs**

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f          # everything
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f worker   # one service
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 api
```

Worker/Redis errors are logged through a redactor; job stages appear as
`[inv_…] Stage: …`.

**Restart a service** (no rebuild):

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml restart api
docker compose --env-file .env.production -f docker-compose.prod.yml restart worker
```

The worker has a 120s stop grace period so an in-flight investigation can
drain and its sibling containers are swept before exit; avoid `-t 0`.

**Redeploy after a code change:**

```sh
git pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

**Stop / tear down** (volumes are preserved unless you add `-v`):

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml down
```

## Scaling workers

The worker holds no ports and no per-replica state, so scale it horizontally
on the host:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --scale worker=3
```

Each replica pulls from the same queue; BullMQ distributes jobs. Total
concurrency ≈ `replicas × INVESTIGATION_WORKER_CONCURRENCY`. Replicas share the
host Docker daemon and the `/var/tmp/sherlock` root (each job clones into its
own subdirectory, so this is safe). Size to host CPU/RAM and Docker capacity;
past a single host, run worker replicas on additional hosts pointed at the same
managed Redis. Do **not** `--scale api` on a single host without changing the
published port mapping (a fixed host port cannot be shared by replicas) — put
api replicas behind the reverse proxy instead.

## Using managed Redis instead of the bundled service

The bundled `redis` service is convenient for a single host. For a managed,
persistent, backed-up Redis (recommended for production):

1. Set `REDIS_URL` in your env file to the provider endpoint, e.g.
   `rediss://:password@my-redis.example.com:6379` (note `rediss://` for TLS).
2. Start only the app services, skipping the bundled Redis:

   ```sh
   docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-deps --build api worker
   ```

   To drop it permanently, remove the `redis` service, its volume, and the two
   `depends_on: redis` blocks from the compose file.

## Domain & HTTPS (reverse proxy)

The api speaks plain HTTP on port 3000. Terminate TLS in front of it. GitHub
requires HTTPS for webhook delivery. Example with Caddy (automatic
certificates):

```
# Caddyfile
sherlock.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then point `API_WEBHOOK_PORT` (default 3000) at the proxy upstream and set the
GitHub webhook URL to `https://sherlock.example.com/api/github/webhooks`.
nginx or Traefik work equally well; the only requirement is TLS termination and
a forward to the api's webhook port. Do not publish port 3000 to the public
internet without TLS in front.

## Known limitations of this first deployment

- **Single host.** api, worker, and (bundled) Redis co-locate. Multi-host is
  supported by pointing workers at managed Redis, but there is no orchestrator
  manifest (Kubernetes/Nomad) yet.
- **Local artifact storage.** Investigation evidence and repo memory live on
  named volumes on the worker host. Only the compact investigation *state* is
  durable in Supabase; object storage for artifacts is future work.
- **Privileged worker.** The worker mounts the host Docker socket, which is
  root-equivalent on that host. Keep the worker host dedicated.
- **Webhook idempotency window.** Redelivery dedup relies on Redis job
  retention (see `INVESTIGATION_JOB_RETENTION`), not a permanent database
  record.
- **No dashboard/auth/billing UI** and **no per-tenant scheduling** yet; the
  worker runs a single global concurrency.
- **Target-container egress** under `permissive` is a documented risk; keep
  `strict` unless you understand the tradeoff.

## Production hardening checklist

- [ ] TLS reverse proxy in front of the api; port 3000 not publicly exposed.
- [ ] `WEBHOOK_SECRET` set and matching the GitHub App; rotate on leak.
- [ ] GitHub App private key mounted read-only (Docker secret), `chmod 400`,
      never committed; rotate periodically.
- [ ] Managed, backed-up Redis with auth + TLS (`rediss://`) for production.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` scoped to backend only; RLS stays enabled
      with no public policies; Supabase backups on.
- [ ] `SHERLOCK_SANDBOX_NETWORK_POLICY=strict`.
- [ ] Worker host dedicated and firewalled (Docker socket = host root).
- [ ] `SHERLOCK_RUN_STARTUP_CHECKS=true`; confirm `npm run worker:check` passes.
- [ ] `GET /readyz` returns 200 before sending traffic; `/healthz` wired to the
      orchestrator liveness probe.
- [ ] Log shipping + retention configured; logs are redacted but still watched.
- [ ] Resource limits (CPU/RAM) set per service for the host's capacity.
- [ ] Backup/restore drill for Redis volume and Supabase.
- [ ] Secret scan clean in CI (see below); no credentials in the repo or images.

## CI/CD

The pipeline should build both images, run the build and tests, and refuse to
ship if a secret pattern appears. Raw commands:

```sh
npm ci
npm run build                                   # tsc -> lib/
npm test -- --run                               # vitest (non-watch)

# Secret scan. grep alone exits 0 on a MATCH and 1 when clean — exactly
# backwards for CI — so `!` inverts it: the step fails (exit 1) on any hit and
# passes when the tree is clean.
! grep -RInE 'gh[pous]_[A-Za-z0-9]{20,}|github_pat[_][A-Za-z0-9_]{20,}|sk[-][A-Za-z0-9-]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|ey[J][A-Za-z0-9_.-]{40,}|SUPABASE_SERVICE_ROLE_KEY=[A-Za-z0-9_.-]{20,}' \
  . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=lib \
    --exclude-dir=dist --exclude-dir=artifacts --exclude-dir=test

# Build both images (no secrets are baked in).
docker build -f Dockerfile        -t sherlock-api:"$GIT_SHA"    .
docker build -f Dockerfile.worker -t sherlock-worker:"$GIT_SHA" .

# Deploy (on the host, after images are pulled/available)
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

The patterns are deliberately shaped to avoid false positives without an
allowlist file: each requires a realistic token *length* after the prefix, so
the short prefix mentions in the redactor (`backend/services/report.ts`) and
in this document don't trip it, and single-character bracket classes
(`gh[pous]_`, `sk[-]`, `ey[J]`) keep the scan command from matching its own
definition. `test/` is excluded because its fixtures are intentionally
token-shaped; everything else in the repo is scanned. If you adopt a dedicated
scanner (gitleaks, trufflehog) later, replace this grep rather than extending
it.

Example GitHub Actions workflow (save as `.github/workflows/ci.yml` when you
want it active — it is intentionally not committed so it does not run on this
scaffolding branch):

```yaml
name: ci
on: [push, pull_request]
jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test -- --run
      - name: Secret scan  # `!` inverts grep: fail on a hit, pass when clean
        run: |
          ! grep -RInE 'gh[pous]_[A-Za-z0-9]{20,}|github_pat[_][A-Za-z0-9_]{20,}|sk[-][A-Za-z0-9-]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|ey[J][A-Za-z0-9_.-]{40,}|SUPABASE_SERVICE_ROLE_KEY=[A-Za-z0-9_.-]{20,}' \
            . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=lib \
              --exclude-dir=dist --exclude-dir=artifacts --exclude-dir=test
      - run: docker build -f Dockerfile        -t sherlock-api:${{ github.sha }}    .
      - run: docker build -f Dockerfile.worker -t sherlock-worker:${{ github.sha }} .
```

> One caveat about the inverted grep: `! grep` also returns success if grep
> itself errors (exit 2, e.g. a bad flag). If you want belt-and-braces, test
> the scan against a deliberately planted long dummy token in CI once, or move
> to a dedicated secret scanner.
