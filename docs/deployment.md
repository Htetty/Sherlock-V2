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
| `SHERLOCK_SUCCESSFUL_ARTIFACT_RETENTION_HOURS` | | ✓ | optional; default `0` after fully delivered verified fix |
| `SHERLOCK_FAILED_ARTIFACT_RETENTION_HOURS` | | ✓ | optional; default `168`, measured after terminal delivery is posted or permanently fails |
| `SHERLOCK_ARTIFACT_CLEANUP_INTERVAL_MINUTES` | | ✓ | optional bounded scan interval; default `60` |
| `SHERLOCK_ARTIFACT_CLEANUP_ON_STARTUP` | | ✓ | optional detached startup scan; default `true` |
| `SHERLOCK_ARTIFACT_CLEANUP_MAX_DIRECTORIES` | | ✓ | optional scan bound; default `250` |
| `SHERLOCK_WORKER_HEARTBEAT_INTERVAL_SECONDS` | | ✓ | optional Redis heartbeat interval; default `15` |
| `SHERLOCK_WORKER_HEARTBEAT_MAX_AGE_SECONDS` | | ✓ | optional freshness limit; default `45` |
| `SHERLOCK_WORKER_HEARTBEAT_TTL_SECONDS` | | ✓ | optional Redis expiry; default `60` |
| `SHERLOCK_QUEUE_MAX_WAIT_AGE_SECONDS` | | ✓ | optional queue backlog warning age; default `600` |
| `SHERLOCK_DISK_WARNING_PERCENT` / `SHERLOCK_DISK_CRITICAL_PERCENT` | | ✓ | optional filesystem thresholds; defaults `80` / `90` |
| `WEBHOOK_PROXY_URL` | ✓ | | smee relay for non-public hosts; blank in prod |

`NODE_ENV`, `SHERLOCK_RUN_STARTUP_CHECKS`, `TMPDIR`, and
`SHERLOCK_SANDBOX_NETWORK` are set by the compose file itself. Optional tuning
(`INVESTIGATION_WORKER_CONCURRENCY`, `SHERLOCK_TARGET_IMAGE`, timeouts) is
listed in the example files.

### Containerized-worker sandbox addressing and ownership

Two things differ when the worker runs inside a container (the compose
topology) instead of directly on a developer machine; both are wired up by
`docker-compose.prod.yml` and verified by the worker preflight
(`sandbox:addressing` check), so they are listed here for understanding, not
as extra setup steps:

- **`SHERLOCK_SANDBOX_NETWORK`** (compose sets `sherlock-sandbox`): target-app
  containers do not publish ports on the host loopback — the worker's
  `localhost` is the worker container, not the Docker host, so it could never
  reach them. Instead the worker and every target app attach to this shared
  bridge network and the worker probes `http://<containerName>:<port>`. The
  network is declared with a fixed name in the compose file; `api` and `redis`
  deliberately stay off it so target code cannot reach them. Leave the
  variable unset for a host-run worker (local development) — loopback
  publishing is correct there, and a containerized worker without it fails
  preflight and every sandbox start with an explicit error.
- **`SHERLOCK_TARGET_UID` / `SHERLOCK_TARGET_GID`** (default `1000:1000`, the
  `node` user in the official Node images): the worker container runs as root,
  and on a Linux daemon bind mounts preserve ownership, so runtime workspace
  copies are chowned to the target-container user before mounting — otherwise
  `npm install` in the sandbox fails with `EACCES` (macOS Docker Desktop masks
  this). Only override these when `SHERLOCK_TARGET_IMAGE` uses a different
  unprivileged uid/gid. A non-root worker skips the chown.

The api will not report ready (`GET /readyz` → 503) until `APP_ID`,
`PRIVATE_KEY`/`PRIVATE_KEY_PATH`, `WEBHOOK_SECRET`, and `ANTHROPIC_API_KEY` are
present (plus `REDIS_URL` when `NODE_ENV=production`, and Supabase creds when
that store is selected). The worker refuses to consume jobs until
`npm run worker:check` passes (enforced at startup).

> **Health port is container-internal.** `/healthz` and `/readyz` are served
> on the backend health port (`BACKEND_PORT`, default 4000), which the compose
> file deliberately does **not** publish — only the webhook port (3000) is
> exposed, and that is the one your reverse proxy fronts. Probe readiness from
> inside the container (see [Verify](#hosted-deploy-runbook-first-deploy)
> below) or, if an external
> load balancer must reach it, publish it bound to loopback only by adding
> `- "127.0.0.1:4000:4000"` to the api service's `ports:` — never expose the
> health port to the public internet.

## Hosted deploy runbook (first deploy)

Follow the steps in order on the deploy host; each one is checked by the
doctor/smoke steps before anything goes live.

1. **Provision the host.** A fresh Ubuntu/Debian VM (2+ vCPU, 4+ GB RAM —
   investigations build and run target containers) needs:

   - **Docker Engine + Compose v2**: install per
     [docs.docker.com/engine/install](https://docs.docker.com/engine/install/),
     then confirm with `docker version` and `docker compose version`.
   - **Git** and **Node.js 22+ with npm** (`node --version`) — Node runs the
     doctor/smoke scripts on the host; the services themselves run in
     containers.
   - **DNS**: an A record for your domain (e.g. `sherlock.example.com`)
     pointing at the host — GitHub only delivers webhooks over HTTPS to a
     public name (see [Domain & HTTPS](#domain--https-reverse-proxy)).
   - **Firewall**: allow inbound **443** (webhooks via the reverse proxy),
     **80** if your proxy uses ACME HTTP-01 for certificates, and SSH.
     Nothing else — **3000** (plain-HTTP webhook port), **4000** (health), and
     **6379** (Redis) must stay unreachable from the internet.

2. **Clone the repo and copy the two secret files** from your secure source
   (a password manager or an `scp` from the machine that holds them — never
   chat, email, or the git repo). Both paths are gitignored:

   ```sh
   git clone <your-sherlock-remote> sherlock && cd sherlock

   # Filled-in env file (see Required environment variables above)
   scp <secure-source>:.env.production .env.production
   chmod 600 .env.production

   # GitHub App private key, where the compose secret expects it
   mkdir -p secrets
   scp <secure-source>:sherlock-app.private-key.pem secrets/github-app-private-key.pem
   chmod 400 secrets/github-app-private-key.pem
   ```

   On a **staging host**, copy the *staging* App's key to the path
   `.env.staging`'s `SHERLOCK_PRIVATE_KEY_FILE` points at instead:

   ```sh
   scp <secure-source>:sherlock-staging-app.private-key.pem secrets/github-app-staging-private-key.pem
   chmod 400 secrets/github-app-staging-private-key.pem
   ```

   No filled-in `.env.production` anywhere yet? Create it on the host from
   the example and fill it in: `cp .env.production.example .env.production`.

   > The stock compose file always mounts the key file as a Docker secret,
   > so it must exist **even if** you set `PRIVATE_KEY` inline in the env
   > file. Inline-only setups additionally require removing the `secrets:`
   > blocks from `docker-compose.prod.yml`; unless you have a reason,
   > keep the key file.

3. **Apply the Supabase migration** (creates `public.investigation_states`,
   RLS enabled with no policies). Simplest path: open the Supabase
   dashboard's **SQL Editor**, paste the contents of
   `supabase/migrations/20260708000000_create_investigation_states.sql`, and
   run it. Alternatively use the Supabase CLI — `db push` requires the repo
   to be linked to your project first:

   ```sh
   supabase link --project-ref <your-project-ref>   # once per project (asks for the DB password)
   supabase db push
   ```

   The table stores only the folded, redacted `InvestigationStateRecord` plus
   safe scalar columns — never issue/comment bodies, tokens, env, or raw
   webhook payloads. Do not add a public anon read policy; the dashboard will
   read through the backend service role or explicit scoped policies later.

4. **Prepare the worker clone directory** on the host (must be an identical
   path inside the container — see production-worker.md):

   ```sh
   sudo mkdir -p /var/tmp/sherlock
   ```

5. **Run the deployment doctor.** It validates everything above before any
   container starts: the env file exists with no placeholder values left, the
   Compose host settings (`SHERLOCK_ENV_FILE`, `SHERLOCK_PRIVATE_KEY_FILE`)
   point at the right files, the private key file is present and non-empty,
   the Docker daemon is reachable, and `docker compose config` parses with
   your `--env-file`. It prints PASS/WARN/FAIL per check, never prints secret
   values, and exits nonzero on blockers — do not deploy until it passes:

   ```sh
   npm run deploy:doctor:prod       # production host (.env.production)
   npm run deploy:doctor:staging    # staging host   (.env.staging)
   ```

6. **Run the compose smoke test.** Where the doctor checks configuration, the
   smoke test proves the stack actually *boots* — in an **isolated smoke
   stack**, not your real deployment. It runs everything under a separate
   Compose project (`sherlock-smoke`) with its own network and volumes
   (including a fresh, empty Redis), removes the api's published webhook
   port, blanks any smee relay, and forces `REDIS_URL` to the smoke-internal
   Redis — so it can never receive real GitHub deliveries or consume jobs
   from your real production/staging queue. It then waits for redis and api
   to report healthy, probes `GET /healthz` and `GET /readyz` from inside the
   api container, and confirms the worker container is *currently running*
   and logged `PASS worker preflight` / `Sherlock investigation worker
   started` during this run. It never prints secret values or log contents
   and exits nonzero on any failure:

   ```sh
   npm run deploy:doctor:prod && npm run deploy:smoke:prod    # before a real deploy
   # staging: npm run deploy:doctor:staging && npm run deploy:smoke:staging
   ```

   The smoke stack is **boot-health evidence only** — it does not process
   jobs and does not prove end-to-end investigation behavior (step 9's
   `/sherlock investigate` pass is what proves that). By default the smoke
   containers are left running for inspection and the stop command is
   printed; pass `--down` to tear the smoke stack (and its volumes) down
   afterwards. A failed teardown exits nonzero:

   ```sh
   npm run deploy:smoke:prod -- --down
   # manual cleanup if ever needed:
   # docker compose -p sherlock-smoke --env-file .env.production -f docker-compose.prod.yml down -v
   ```

   The generated isolation override uses `ports: !reset`, which needs
   Docker Compose v2.24 or newer.

7. **Build and start the real stack** (the smoke stack from the previous
   step is isolated and is *not* your deployment; note `--env-file` — see
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

8. **Point the GitHub App at the host**: set the App's webhook URL to
   `https://<your-domain>/api/github/webhooks` — details in
   [GitHub App webhook URL](#github-app-webhook-url) below. (Requires the TLS
   reverse proxy from [Domain & HTTPS](#domain--https-reverse-proxy).)

9. **Verify** (readiness is probed from *inside* the container — the health
   port is not published):

   ```sh
   docker compose --env-file .env.production -f docker-compose.prod.yml ps
   # api readiness (container-internal port 4000)
   docker compose --env-file .env.production -f docker-compose.prod.yml exec api \
     node -e "fetch('http://127.0.0.1:4000/readyz').then(r=>r.text()).then(console.log)"
   # deep worker host check
   docker compose --env-file .env.production -f docker-compose.prod.yml exec worker npm run worker:check
   # concise API/Redis/worker/queue/storage/cleanup state
   docker compose --env-file .env.production -f docker-compose.prod.yml exec worker npm run ops:check:prod
   # redis health
   docker compose --env-file .env.production -f docker-compose.prod.yml exec redis redis-cli ping
   # recent logs (see Operating below for follow mode)
   docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=100 api
   docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=100 worker
   ```

   Expected: `ps` shows redis/api/worker `healthy`, `/readyz`
   returns ready, redis answers `PONG`, api logs show webhook deliveries once
   the App is pointed at the host, and worker logs show
   `PASS worker preflight`.

   Finally, do one end-to-end pass: comment `/sherlock investigate` on a test
   issue in a repo where the App is installed, watch the worker log
   `[inv_…] Stage: …` lines, and confirm a new row appears in Supabase
   (**Table Editor → `investigation_states`**, or
   `select investigation_id, status, stage, updated_at from
   investigation_states order by updated_at desc limit 5;` in the SQL editor). If no row appears, check
   `SHERLOCK_STATE_STORE=supabase` and the Supabase values in the env file,
   then the worker logs.

Before announcing the deployment, read
[Known limitations](#known-limitations-of-this-first-deployment) — notably the
worker's Docker-socket access (host-root equivalent), the bundled Redis, local
artifact storage, and the absence of a dashboard — and work through the
[Production hardening checklist](#production-hardening-checklist).

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

**Production state check**

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml exec worker npm run ops:check:prod
```

Run this after every deploy and on a five-minute schedule from the host. It
prints only fixed labels, counts, ages, percentages, and PASS/WARN/FAIL. FAIL
exits nonzero; WARN stays zero so an operator can distinguish urgent outages
from capacity and backlog signals. It never reads queue payloads, artifact
contents, environment values, or API response bodies.

The signals answer different questions: `/healthz` proves the API process is
serving; Redis PING proves the shared queue store responds; the expiring
per-worker heartbeat proves a worker recently reached Redis; queue age and
disk/cleanup status expose accumulating operational risk. None proves GitHub,
Anthropic, Docker, a customer repository, and its tests can complete an
investigation. Keep a controlled end-to-end investigation in the release
procedure.

Operator response:

- **Missing/stale heartbeat:** inspect `docker compose ... ps worker` and the
  worker's recent logs. Check Redis reachability and startup preflight before
  restarting it. A stopped worker's record expires automatically.
- **Old waiting work:** first verify a fresh heartbeat and active count, then
  inspect worker capacity and delayed jobs. Scale only after ruling out a
  repeatedly failing dependency or intentionally delayed retries.
- **Disk warning/critical:** stop adding load at critical usage, inspect the
  named volume/host filesystem and cleanup counters, and add capacity or fix
  cleanup failures. Do not bulk-delete artifact directories; retention
  protects active and incompletely delivered investigations.
- **Cleanup warning:** use the last-run age, scanned/deleted/retained/protected/
  failure counts, and oldest retained failure age to distinguish an idle
  system from a failed or bounded scan. Cleanup uncertainty retains data.

Docker Compose rotates each service's local `json-file` logs at 10 MB with
three files by default. `SHERLOCK_DOCKER_LOG_MAX_SIZE` and
`SHERLOCK_DOCKER_LOG_MAX_FILES` tune those bounds through `--env-file`; remote
log shipping and host capacity alerts remain operator responsibilities.

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

Do not run mixed old/new binaries during the opaque queue-ID upgrade. The
normal single-host Compose recreate stops the old processes first and requires
no queue drain: already-queued legacy IDs remain consumable, retained legacy
webhook claims are checked during enqueue, and legacy delivery IDs remain
protected from artifact cleanup. If a platform performs rolling replacement,
stop webhook ingestion before replacing all api/worker replicas together.

**Redeploy after a code change:**

```sh
git pull
npm run deploy:doctor:prod             # staging: npm run deploy:doctor:staging
npm run deploy:smoke:prod -- --down    # isolated boot check; does not touch the real stack
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

**Roll back to the last good version** — a deploy is just "build and start
the checked-out commit", so rolling back is checking out the previous good
commit and redeploying it:

```sh
git log --oneline -10                        # find the last good commit
git checkout <last-good-sha>
npm run deploy:doctor:prod                   # config sanity
npm run deploy:smoke:prod -- --down          # isolated boot check — NOT the real stack
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

The final `up -d --build` is the actual rollback: the smoke test only boots a
throwaway `sherlock-smoke` project and never touches the real deployment, so
skipping the last command would leave the broken version running. Volumes
(Redis queue, artifacts, repo memory) are untouched, so queued jobs
survive the rollback. `.env.production` and `secrets/` are gitignored and
unaffected by the checkout — but if the bad deploy also changed the env file,
restore the previous env file from your secure source first (the doctor will
catch missing/placeholder values). Once a fixed version ships, return to the
branch with `git checkout <branch>` and redeploy the same way.

**Stop / tear down** (volumes are preserved unless you add `-v`):

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml down
```

## Scaling workers

The worker holds no ports, but delivery state and protected retry payloads are
filesystem-coordinated. Scale it horizontally only when every replica mounts
the same shared POSIX `ARTIFACTS_DIR` volume:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --scale worker=3
```

Each replica pulls from the same queue; BullMQ distributes jobs. Total
concurrency ≈ `replicas × INVESTIGATION_WORKER_CONCURRENCY`. Replicas share the
host Docker daemon, the shared artifacts volume, and the `/var/tmp/sherlock`
root (each job clones into its own subdirectory, so this is safe). Size to host
CPU/RAM and Docker capacity. Managed Redis alone is not enough for multi-host
workers: the current architecture requires one shared POSIX artifact volume
with correct directory-rename, mode, and mtime semantics on every worker. Do **not**
`--scale api` on a single host without changing the published port mapping (a
fixed host port cannot be shared by replicas) — put api replicas behind the
reverse proxy instead.

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

- **Single host.** api, worker, and (bundled) Redis co-locate. Multi-host workers
  are not supported by Redis alone; all workers currently require the same
  shared POSIX artifact volume, and there is no orchestrator manifest
  (Kubernetes/Nomad) yet.
- **Bundled Redis is a convenience, not production-grade.** It is single-node,
  unauthenticated (reachable only on the compose-internal network), and its
  durability is one append-only volume on the same host — a host loss loses
  the queue. Use a managed Redis with auth + TLS for real production (see
  [Using managed Redis](#using-managed-redis-instead-of-the-bundled-service)).
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
npm run deploy:doctor:prod
npm run deploy:smoke:prod -- --down    # isolated boot-health check
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
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
