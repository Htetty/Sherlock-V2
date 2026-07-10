# sherlock-backend

> A GitHub App built with [Probot](https://github.com/probot/probot) that A Probot app

## Setup

```sh
# Install dependencies
npm install

# Run the bot
npm start
```

## Docker

```sh
# 1. Build container
docker build -t sherlock-backend .

# 2. Start container
docker run -e APP_ID=<app-id> -e PRIVATE_KEY=<pem-value> sherlock-backend
```

## Production deployment

A full single-host/staging deployment (separate **api**, **worker**, and
**redis** services, persistent volumes, Docker secrets, health/readiness
endpoints) is defined in
[docker-compose.prod.yml](docker-compose.prod.yml):

```sh
cp .env.production.example .env.production      # fill in real values (gitignored)
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

(`--env-file` is required: it feeds the compose host settings — ports, volume
paths, the private-key path — into `${...}` interpolation, which the
container-level `env_file:` cannot do. Staging: `--env-file .env.staging`.)

The api exposes `GET /healthz` (liveness) and `GET /readyz` (config readiness;
variable names only, never values) on the container-internal health port. See
[docs/deployment.md](docs/deployment.md) for the architecture diagram, required
services and env vars, the Supabase migration and GitHub webhook URL setup,
how to view logs, restart/scale services, switch to managed Redis, add
domain/HTTPS, the known limitations, the hardening checklist, and CI/CD notes.

## Production worker

The investigation worker has its own production image (`Dockerfile.worker`)
and a runtime preflight:

```sh
# verify a host has everything the worker needs (git, Docker CLI + daemon,
# target image, Redis, Playwright Chromium, writable dirs, env vars;
# a missing graphify only warns)
npm run worker:check

# fail fast at startup instead of consuming jobs on a broken host
SHERLOCK_RUN_STARTUP_CHECKS=true npm run worker
```

See [docs/production-worker.md](docs/production-worker.md) for the worker
image build, required environment variables, Graphify packaging, the
Docker-socket requirement, and the Docker-outside-of-Docker path-alignment
warning (sibling target containers bind-mount clone paths, so the worker's
workspace path must exist from the Docker daemon host's perspective).

### Investigation state store (optional)

The worker can persist a small, redacted per-investigation lifecycle summary
via `SHERLOCK_STATE_STORE` (`file` or `supabase`; default is a no-op that
records nothing). For Supabase, set `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY=redact-me` (backend/worker only — never expose the
service role key to client code) and apply the migration in
[supabase/migrations/](supabase/migrations/). RLS is enabled with no policies;
the backend service role bypasses it. See
[docs/production-worker.md](docs/production-worker.md#investigation-state-store-optional)
for details.

## Contributing

If you have suggestions for how sherlock-backend could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2026 Htet Htwe & Myo Aung
