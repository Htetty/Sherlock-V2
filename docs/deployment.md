# Sherlock production deployment

This is the operator runbook for the single-host production topology defined
in [`docker-compose.prod.yml`](../docker-compose.prod.yml). The stack contains:

- `api`: GitHub App webhook ingress and health/readiness server.
- `worker`: BullMQ investigation worker with Docker and Playwright access.
- `redis`: durable queue and command-deduplication state.
- Supabase: externally hosted product, installation, investigation, and
  private replay-evidence data.

For worker-specific Docker and filesystem requirements, also read
[`production-worker.md`](production-worker.md). For the dashboard schema
rollout, read
[`dashboard-data-platform-rollout.md`](dashboard-data-platform-rollout.md).

## Host requirements

Use a dedicated Linux host. The worker mounts `/var/run/docker.sock`, which is
effectively host-root access, and runs customer repository code in sibling
containers. Do not colocate unrelated workloads on this machine.

Install:

- Docker Engine and Docker Compose v2.24 or newer.
- Git.
- Node.js 22 or newer, used by the deployment doctor and smoke scripts.
- A TLS-terminating reverse proxy such as Caddy or nginx.

Allow public inbound traffic only on ports 80/443 and SSH. Keep Redis and the
internal health port private. Bind the webhook container port to loopback:

```dotenv
API_WEBHOOK_PORT=127.0.0.1:3000
```

## Environment and secrets

Create the production env file from the tracked example:

```sh
cp .env.production.example .env.production
```

Fill every required value and leave the completed file untracked. Store the
GitHub App private key at:

```text
secrets/github-app-private-key.pem
```

Protect both files:

```sh
chmod 600 .env.production
chmod 400 secrets/github-app-private-key.pem
```

The expected key settings are:

```dotenv
PRIVATE_KEY_PATH=/run/secrets/github_app_private_key
SHERLOCK_PRIVATE_KEY_FILE=./secrets/github-app-private-key.pem
```

Staging must use `.env.staging` and a separate staging App key. Never point a
staging deployment at the production key.

## Supabase

Apply all tracked migrations under [`supabase/migrations`](../supabase/migrations)
to the production Supabase project in timestamp order. Then follow the
dashboard reconciliation and verification steps in
[`dashboard-data-platform-rollout.md`](dashboard-data-platform-rollout.md).

The Supabase service-role key is backend-only. Never expose it through a
`NEXT_PUBLIC_*` variable or send it to the landing application.

## Pre-deployment verification

Always pass the env file to Compose itself. Compose interpolation does not read
the service-level `env_file` setting:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml config
```

Run the production doctor and isolated smoke test before changing the live
stack:

```sh
npm run deploy:doctor:prod
npm run deploy:smoke:prod -- --down
```

Do not deploy while either command reports a blocker. The smoke test verifies
that Redis, API readiness, and worker startup succeed in an isolated Compose
project; it does not consume a real investigation.

## Deploy

Build and start all services from the same repository commit:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

Check container state and bounded logs:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml ps
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 api worker
```

Probe API liveness and readiness from inside the container because port 4000
is intentionally not published:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml exec api \
  node -e "fetch('http://127.0.0.1:4000/healthz').then(async r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

docker compose --env-file .env.production -f docker-compose.prod.yml exec api \
  node -e "fetch('http://127.0.0.1:4000/readyz').then(async r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
```

Run the worker operations check:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml exec worker \
  node ./lib/backend/ops-check.js
```

## External configuration

Configure the GitHub App with:

- Webhook URL: `https://<backend-origin>/api/github/webhooks`
- Setup URL: `https://<backend-origin>/api/github/installations/callback`
- Webhook events: `issue_comment`, `installation`, and
  `installation_repositories`
- Permissions matching [`app.yml`](../app.yml)

Set `SHERLOCK_FRONTEND_URL` to the deployed landing/dashboard origin. In
Supabase Auth, allowlist that origin's `/auth/callback` URL.

Terminate TLS at the reverse proxy and forward only the webhook/API ingress to
`127.0.0.1:3000`. Do not expose ports 3000, 4000, or 6379 directly.

## End-to-end launch check

After health checks pass:

1. Install the production GitHub App on an approved test repository.
2. Confirm the installation and repositories appear in the dashboard.
3. Comment `/sherlock investigate` on a controlled test issue.
4. Confirm the queued comment is updated to a truthful terminal result.
5. Confirm the investigation, exact diff, and any private replay evidence are
   readable only by the authorized dashboard user.
6. Confirm a verified fix creates or reuses one Sherlock branch and one pull
   request.

## Updating and rollback

Before an update, record the deployed commit and back up durable data. Deploy
the API and worker from the same commit:

```sh
git pull --ff-only
npm run deploy:doctor:prod
npm run deploy:smoke:prod -- --down
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

To roll back, check out the previously recorded commit and rebuild the stack.
Do not delete the Redis, artifact, or Sherlock data volumes during an ordinary
rollback.

## Operational cautions

- The Docker socket makes the worker host security-critical.
- Keep artifact and Sherlock data volumes durable and monitor disk usage.
- Keep Redis append-only persistence enabled or use a managed Redis service.
- Rotate GitHub, Anthropic, Supabase, and webhook secrets after any suspected
  exposure.
- Never paste env files, private keys, customer source, or investigation
  artifacts into tickets or chat.
