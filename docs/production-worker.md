# Production worker

The BullMQ worker runs investigations, Playwright Chromium, replay recording,
ffmpeg media generation, and GitHub delivery. The production image includes
Chromium, ffmpeg, git, the Docker CLI, and the compiled application.

## Compose deployment

Use the production Compose file so the worker, Redis, persistent artifacts,
Docker socket, and shared sandbox network are wired consistently:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

Apply every SQL file in `supabase/migrations/` before deployment. This creates
the investigation-state table and the public, service-role-written
`sherlock-evidence` bucket used for GitHub replay evidence.

## Manual worker run

A containerized worker must be attached to the same named network as sibling
target containers. The startup preflight verifies the attachment.

```sh
docker network create sherlock-sandbox

docker run -d --name sherlock-worker \
  --network sherlock-sandbox \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v sherlock-artifacts:/app/artifacts \
  -e SHERLOCK_SANDBOX_NETWORK=sherlock-sandbox \
  -e APP_ID \
  -e PRIVATE_KEY \
  -e ANTHROPIC_API_KEY \
  -e REDIS_URL \
  -e SUPABASE_URL \
  -e SUPABASE_SERVICE_ROLE_KEY \
  sherlock-worker
```

Browser and mixed reproduction plans record automatically. If Chromium video
capture, ffmpeg conversion, Supabase upload, or public URL generation fails,
the investigation and GitHub comment still complete without replay media.
API-only plans intentionally produce no video.

Replay media is hosted at public, unguessable URLs even for private
repositories because GitHub comments cannot embed authenticated Storage
objects. Anyone who obtains one of those URLs can view its media.

## Preflight

Run `npm run worker:check` inside the deployed worker environment. Mandatory
checks cover credentials, Redis, Docker, sandbox addressing, Chromium, and
writable paths. ffmpeg is reported separately so evidence failures are visible
without blocking investigations.
