# Production worker runtime

The Sherlock investigation worker (`lib/backend/worker.js`) is the BullMQ
consumer that runs the full investigation pipeline: clone → sandbox →
reproduction → fix → verification → pull request. This document covers what
it needs at runtime, how to build the production image, and how to verify a
host with `npm run worker:check`.

## Runtime requirements

| Dependency | Why | Check |
| --- | --- | --- |
| Node `>=22` | worker runtime (required by `@supabase/supabase-js`) | — |
| `git` | repository cloning | mandatory |
| Docker CLI + reachable daemon | target apps and all validation/regression commands run in restricted containers | mandatory |
| Target image (`SHERLOCK_TARGET_IMAGE`, default `node:20-slim`) | base image for target containers | mandatory (pullable is enough) |
| Redis (`REDIS_URL`, default `redis://localhost:6379`) | BullMQ queue | mandatory |
| Playwright Chromium + native libs | reproduction browser (runs on the worker itself) | mandatory |
| Writable `ARTIFACTS_DIR` (default `./artifacts`) | investigation evidence | mandatory |
| Writable `SHERLOCK_DATA_DIR` (default `~/.sherlock`) | repo memory | mandatory |
| Writable temp dir | clone workspaces | mandatory |
| `graphify` on PATH (`uv tool install "graphifyy[anthropic]"`) | graph repository context | optional — the pipeline degrades to heuristic context without it (WARN, not FAIL) |

Required environment variables (values are never printed by any check):

- `APP_ID` — GitHub App id
- `PRIVATE_KEY` **or** `PRIVATE_KEY_PATH` — GitHub App private key
- `ANTHROPIC_API_KEY` — plan/fix/regression generation
- `ANTHROPIC_MODEL` — optional; overrides the default Anthropic model
  (`claude-sonnet-5`) used for all model calls
- `REDIS_URL` — optional; the default is reported explicitly when unset
- `SHERLOCK_TARGET_IMAGE`, `ARTIFACTS_DIR`, `SHERLOCK_DATA_DIR` — optional overrides
- `SHERLOCK_SUCCESSFUL_ARTIFACT_RETENTION_HOURS` — raw-artifact retention
  after a verified fix, pull request, and terminal comment are fully delivered
  (default `0`, immediate)
- `SHERLOCK_FAILED_ARTIFACT_RETENTION_HOURS` — raw-artifact retention for
  terminal non-success investigations, measured from confirmed terminal
  comment delivery (default `168`, seven days)
- `SHERLOCK_ARTIFACT_CLEANUP_INTERVAL_MINUTES` — periodic bounded scan
  interval (default `60`; `0` disables periodic scans)
- `SHERLOCK_ARTIFACT_CLEANUP_ON_STARTUP` — run a detached bounded scan when
  the worker starts (default `true`)
- `SHERLOCK_ARTIFACT_CLEANUP_MAX_DIRECTORIES` — maximum artifact-root entries
  and pending queue jobs considered by one scan (default `250`; excess queue
  state makes cleanup retain everything)
- `SHERLOCK_STATE_STORE` — optional; `file` or `supabase` enables durable
  investigation-state persistence (see "Investigation state store" below).
  When `supabase`, also set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
  (backend/worker only)

## Preflight: `npm run worker:check`

Validates everything above and prints one `PASS` / `WARN` / `FAIL` line per
check with a safe reason. Exit code is `0` only when every mandatory check
passes; `graphify` problems only warn. The preflight is strictly local and
read-only: it never clones customer repositories, calls GitHub or Anthropic,
starts an investigation, runs customer code, or prints secret values.

## Startup enforcement

Local development stays unchanged: `npm run worker` starts immediately.
Setting `SHERLOCK_RUN_STARTUP_CHECKS=true` (the production image sets it by
default) runs the preflight before the BullMQ worker is created; if a
mandatory check fails, the process exits nonzero **before consuming any
job**. Asynchronous Redis/worker errors are logged through a redacting
error handler instead of failing silently.

## Building and running the production image

```bash
docker build -f Dockerfile.worker -t sherlock-worker .

# Shared sandbox network: a containerized worker cannot reach sibling target
# containers via localhost, so both sides attach here and the worker probes
# target apps by container name (docker-compose.prod.yml wires this up
# automatically; only manual `docker run` needs these two steps).
docker network create sherlock-sandbox

docker run -d --name sherlock-worker \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --network sherlock-sandbox \
  -e SHERLOCK_SANDBOX_NETWORK=sherlock-sandbox \
  -e APP_ID=... \
  -e PRIVATE_KEY="$(cat private-key.pem)" \
  -e ANTHROPIC_API_KEY=... \
  -e REDIS_URL=redis://redis-host:6379 \
  sherlock-worker

# one-off host verification with the same image (--network is required: the
# preflight verifies this container is actually ATTACHED to the sandbox
# network, not just that the network exists)
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  --network sherlock-sandbox \
  -e SHERLOCK_SANDBOX_NETWORK=sherlock-sandbox \
  -e APP_ID=... -e PRIVATE_KEY=... -e ANTHROPIC_API_KEY=... -e REDIS_URL=... \
  sherlock-worker npm run worker:check
```

The image compiles TypeScript during the build (`npm run build`; `lib/` is
gitignored so a clean checkout has no JS), installs git, the Docker CLI,
Playwright Chromium with `--with-deps`, and uv + `graphifyy[anthropic]`
(graphify install failures only warn). No secrets are baked in, and no
customer repository dependencies are installed — those are installed inside
sibling target containers at investigation time.

## Docker-outside-of-Docker: path alignment warning

The worker talks to the **host's** Docker daemon through the mounted socket,
so target containers are *siblings* of the worker container, not children.
Sibling containers bind-mount the cloned workspace path — and the daemon
resolves that path on the **daemon host's** filesystem, not inside the
worker container. The worker's temp/clone directory must therefore be a
path that exists identically from the daemon's perspective (e.g. run the
worker with `-v /var/tmp/sherlock:/var/tmp/sherlock -e TMPDIR=/var/tmp/sherlock`
on the host, or run the worker directly on the daemon host). If the paths
are not aligned, target containers see empty `/app` mounts and every
investigation fails as `environment_failed`.

## Investigation state store (optional)

The worker records a small, dashboard-friendly summary of each investigation's
lifecycle (status, stage, reproduction/fixer/PR outcomes, redacted errors)
through the `InvestigationStateStore` abstraction. It is separate from the rich
artifacts under `ARTIFACTS_DIR` and is **best-effort**: a failing store logs a
warning and never fails an investigation.

Select a backend with `SHERLOCK_STATE_STORE` (default: no-op, records nothing):

| `SHERLOCK_STATE_STORE` | Backend | Notes |
| --- | --- | --- |
| unset / anything else | no-op | default; nothing persisted |
| `file` | local JSON | one file per investigation under `SHERLOCK_STATE_STORE_DIR` (default `ARTIFACTS_DIR/_state`) |
| `supabase` | Supabase/Postgres | durable; one folded row per investigation |

### Supabase backend

Environment variables (backend/worker only — never ship the service role key
to browser/client code):

- `SHERLOCK_STATE_STORE=supabase`
- `SUPABASE_URL` — e.g. `https://example.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY=redact-me` — service role key; backend-only
- `SHERLOCK_STATE_STORE_TABLE` — optional, defaults to `investigation_states`

Apply the migration in `supabase/migrations/` (via the Supabase CLI or SQL
editor) to create `public.investigation_states`. The table stores only the
folded, redacted `InvestigationStateRecord` (JSONB) plus safe scalar columns
for listing/filtering — never issue bodies, trigger-comment bodies,
installation tokens, environment variables, raw webhook payloads, or raw
events.

Security:

- Row Level Security is **enabled with no policies**: `anon` and
  `authenticated` roles are denied. The backend uses the service role key,
  which bypasses RLS. Do **not** add a public anon read policy — dashboard
  reads will come later through a backend API or explicit scoped policies.
- The service role key is a backend/worker secret. Keep it out of any
  client-side bundle or public config.
- When `SHERLOCK_STATE_STORE=supabase` and `SUPABASE_URL` or
  `SUPABASE_SERVICE_ROLE_KEY` is missing, runtime writes stay non-fatal
  (swallowed by the pipeline) and `npm run worker:check` fails clearly
  (`state-store:supabase`).

## Investigation artifact retention

The worker treats raw investigation artifacts as a separate storage class
from repository memory, graph caches, Redis queue state, and Supabase rows.
Cleanup only targets a validated `ARTIFACTS_DIR/inv_*` directory. It never
targets `SHERLOCK_DATA_DIR`, Redis, or Supabase.

Deletion eligibility is proved from the local `delivery-state.json`. A
verified fix is eligible only after its branch is pushed, its pull request is
created or safely reused, and its terminal issue comment is confirmed posted.
Non-success outcomes begin their retention clock only after the terminal
comment is posted. Pending or failed branch/PR/comment delivery, missing or
malformed delivery state, active/delayed/waiting BullMQ work, and a live
investigation concurrency lease all retain artifacts.

The worker checks eligibility after BullMQ emits a completed event, starts one
bounded scan without delaying worker startup, and repeats the scan at the
configured interval. Cleanup is idempotent and best-effort: filesystem or
Redis uncertainty retains artifacts and does not change the investigation
result. Deleting raw artifacts removes manual replay/debug evidence, but does
not delete repository memory under `SHERLOCK_DATA_DIR/memory`, graph caches,
structured Supabase state, or queue records.

## Not included (deliberately, for now)

- object storage (artifacts and memory stay on local disk; only the compact
  investigation *state* summary can be persisted to Supabase)
- dashboard UI, auth UI, and billing
- outbound network policy for target containers (documented risk)
- durable webhook idempotency beyond Redis job retention
- deployment-platform-specific compose/manifests (`compose.yml` remains
  Redis-only for local development)
