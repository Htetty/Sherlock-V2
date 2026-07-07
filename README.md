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

## Contributing

If you have suggestions for how sherlock-backend could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2026 Htet Htwe & Myo Aung
