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

### Investigation artifacts

Sherlock retains each `artifacts/<investigationId>/` directory so later agent
runs can use its evidence and replay plans as memory. There is no automatic
age-based deletion; operators should provision the artifact volume as durable
storage and manage capacity without removing replay inputs Sherlock still uses.

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

### Replay evidence

Sherlock can record the reproduction run (where the bug fails) and the
post-fix verification run (where the exact saved plan passes), build a
side-by-side comparison, and embed it in the GitHub comment as visual proof.
See [docs/FABLE_REPLAY_EVIDENCE_PROMPT.md](docs/FABLE_REPLAY_EVIDENCE_PROMPT.md)
for the design.

- Browser and mixed reproduction plans automatically record `videos/run.webm`
  and `videos/post-patch.webm`. API-only plans have nothing visual to record;
  recording failures fall back to the normal report.
- `ffmpeg` in the worker image produces
  `evidence/evidence.mp4` (side-by-side) and a bounded `evidence/evidence.gif`.
- Recording always stays enabled and local. **Public upload is disabled by
  default**: media only reaches the public `sherlock-evidence` bucket when
  `SHERLOCK_PUBLIC_REPLAY_UPLOAD_MODE=allowlist` **and** the repository's
  exact `owner/repo` appears in `SHERLOCK_PUBLIC_REPLAY_ALLOWLIST`
  (comma-separated, case-insensitive, no wildcards). Allowlist mode is
  intended only for explicitly approved, Sherlock-controlled demo
  repositories: uploaded objects are publicly readable at an unguessable URL
  because GitHub cannot embed authenticated Storage objects. When upload is
  skipped, the GitHub report simply omits the replay media; the investigation
  is never affected. Previously published objects and URLs remain untouched.

## Dashboard API and GitHub App onboarding

The backend exposes a small SaaS control layer for the Sherlock dashboard
frontend (separate repository):

- `GET /api/me` — verifies the caller's Supabase access token
  (`Authorization: Bearer <token>`), maps the user to their immutable GitHub
  identity, and synchronizes `public.profiles`.
- `GET /api/installations` — the caller's GitHub App installations, scoped
  strictly through `user_installations` membership.
- `POST /api/installations/start` — mints a one-time, hashed, 15-minute
  installation state and returns the GitHub App installation URL.
- `GET /api/github/installations/callback` — the GitHub App **setup
  callback**. Verifies the state nonce, fetches the installation from
  GitHub's App API with App credentials, applies the ownership policy
  (personal installations: installation account id must equal the user's
  GitHub id; organization installations: the verified `installation.created`
  webhook sender id must equal the user's GitHub id), records membership, and
  redirects to `SHERLOCK_FRONTEND_URL`. For `setup_action=update`, an
  already-known installation may return without the one-time installation
  nonce: the callback re-verifies it through GitHub and reconciles repository
  access, but never creates or changes user membership on that path.

Installation lifecycle webhooks (`installation.*`,
`installation_repositories.*`) are persisted by the Probot process
(`src/installation-events.ts`). Existing `/sherlock investigate` comment
investigations are fully independent of dashboard onboarding: repositories
keep working whether or not anyone has signed into the dashboard.

### External configuration required (not managed by this repository)

Deploying the dashboard API requires these steps **outside** this codebase —
none of them happen automatically:

1. **Supabase migrations** — apply the additive migrations in
   [supabase/migrations/](supabase/migrations/) (profiles, installations,
   membership, repositories, nonces + the `consume_github_installation_nonce`
   RPC) to the shared Supabase project. Existing migrations are unchanged.
2. **Supabase Auth** — the frontend and backend use the SAME Supabase
   project. Enable GitHub as an auth provider. The GitHub **OAuth App**
   callback URL points at Supabase Auth (`https://<project>.supabase.co/auth/v1/callback`),
   NOT at this backend; the frontend owns the browser `/auth/callback` route.
3. **Keys** — the frontend uses the publishable key; this backend uses
   `SUPABASE_PUBLISHABLE_KEY` only to verify user tokens and
   `SUPABASE_SERVICE_ROLE_KEY` only for trusted persistence.
4. **GitHub App setup URL** — in the deployed GitHub App's settings, set the
   Setup URL to `https://<backend-origin>/api/github/installations/callback`
   and enable **Redirect on update** so adding or removing repository access
   returns to Sherlock. `<backend-origin>` must be the same deployed origin
   configured as the frontend's server-only `SHERLOCK_API_URL`.
5. **GitHub App webhook events** — subscribe the deployed App to
   **Installation**, **Installation repositories**, and **Issue comment**.
   Editing `app.yml` alone does NOT change an existing GitHub App.
6. **Frontend origin** — set `SHERLOCK_FRONTEND_URL` (e.g.
   `https://getsherlock.dev`, subject to deployment verification). The setup
   callback redirects only to this origin.
7. **Deploy + restart** — the api container needs the new environment
   variables (`SUPABASE_PUBLISHABLE_KEY`, `SHERLOCK_FRONTEND_URL`,
   `GITHUB_APP_SLUG`); the worker needs the replay policy variables if you
   enable allowlisted public uploads.

## Contributing

If you have suggestions for how sherlock-backend could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2026 Htet Htwe & Myo Aung
