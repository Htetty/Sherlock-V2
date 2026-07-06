# Production worker runtime

The Sherlock investigation worker (`lib/backend/worker.js`) is the BullMQ
consumer that runs the full investigation pipeline: clone → sandbox →
reproduction → fix → verification → pull request. This document covers what
it needs at runtime, how to build the production image, and how to verify a
host with `npm run worker:check`.

## Runtime requirements

| Dependency | Why | Check |
| --- | --- | --- |
| Node `^20.18.1 \|\| >=22` | worker runtime | — |
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
- `REDIS_URL` — optional; the default is reported explicitly when unset
- `SHERLOCK_TARGET_IMAGE`, `ARTIFACTS_DIR`, `SHERLOCK_DATA_DIR` — optional overrides

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

docker run -d --name sherlock-worker \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e APP_ID=... \
  -e PRIVATE_KEY="$(cat private-key.pem)" \
  -e ANTHROPIC_API_KEY=... \
  -e REDIS_URL=redis://redis-host:6379 \
  sherlock-worker

# one-off host verification with the same image
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
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

## Not included (deliberately, for now)

- database or object storage (artifacts and memory stay on local disk)
- outbound network policy for target containers (documented risk)
- durable webhook idempotency beyond Redis job retention
- deployment-platform-specific compose/manifests (`compose.yml` remains
  Redis-only for local development)
