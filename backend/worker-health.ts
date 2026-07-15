// Docker worker health command: proves that this worker's expiring Redis
// heartbeat is present and fresh. It does not claim GitHub, Anthropic,
// Docker sandbox, Supabase, or end-to-end investigation capability.

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import {
  asOperationalRedis,
  getProductionMonitoringConfig,
  getWorkerId,
  readWorkerHeartbeat,
} from "./services/production-monitoring.js";

export async function runWorkerHealthCheck(
  env: NodeJS.ProcessEnv = process.env,
  write: (message: string) => void = (message) => console.log(message),
): Promise<number> {
  let redis: Redis | null = null;
  try {
    const config = getProductionMonitoringConfig(env);
    const workerId = getWorkerId(env);
    redis = new Redis(env.REDIS_URL ?? "redis://localhost:6379", {
      lazyConnect: true,
      connectTimeout: config.requestTimeoutMs,
      commandTimeout: config.requestTimeoutMs,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    await redis.connect();
    const result = await readWorkerHeartbeat(
      asOperationalRedis(redis),
      workerId,
      { maxAgeMs: config.heartbeatMaxAgeMs },
    );
    if (!result.healthy) {
      write("FAIL worker heartbeat is missing or stale");
      return 1;
    }
    write(`PASS worker heartbeat is fresh (${Math.floor((result.ageMs ?? 0) / 1_000)}s)`);
    return 0;
  } catch {
    write("FAIL worker heartbeat or Redis is unavailable");
    return 1;
  } finally {
    redis?.disconnect();
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  process.exit(await runWorkerHealthCheck());
}
