// Safe, concise operator report composition. Adapters return only typed
// booleans, counts, ages, and percentages; raw errors, queue payloads,
// filesystem paths, and artifact content never enter report formatting.

import type {
  FilesystemUsage,
  ProductionMonitoringConfig,
  QueueOperationalSummary,
  WorkerHeartbeatSummary,
} from "./production-monitoring.js";

export type OperationalStatus = "pass" | "warn" | "fail";

export type OperationalCheck = {
  name: string;
  status: OperationalStatus;
  detail: string;
};

export type ProductionOpsReport = {
  overall: OperationalStatus;
  exitCode: number;
  checks: OperationalCheck[];
};

export type ProductionOpsAdapters = {
  apiHealth(): Promise<boolean>;
  redisPing(): Promise<boolean>;
  workerHeartbeats(): Promise<WorkerHeartbeatSummary>;
  queueSummary(): Promise<QueueOperationalSummary>;
  filesystemUsage(): Promise<FilesystemUsage[]>;
};

export async function runProductionOpsCheck(
  config: ProductionMonitoringConfig,
  adapters: ProductionOpsAdapters,
): Promise<ProductionOpsReport> {
  const checks: OperationalCheck[] = [];
  const add = (
    name: string,
    status: OperationalStatus,
    detail: string,
  ) => checks.push({ name, status, detail });

  try {
    const healthy = await adapters.apiHealth();
    add(
      "api-health",
      healthy ? "pass" : "fail",
      healthy
        ? "API liveness endpoint responded successfully"
        : "API health endpoint returned an unhealthy result",
    );
  } catch {
    add("api-health", "fail", "API health endpoint is unreachable");
  }

  try {
    const reachable = await adapters.redisPing();
    add(
      "redis",
      reachable ? "pass" : "fail",
      reachable ? "Redis PING succeeded" : "Redis PING failed",
    );
  } catch {
    add("redis", "fail", "Redis is unreachable");
  }

  try {
    const heartbeat = await adapters.workerHeartbeats();
    const detail = [
      `fresh=${heartbeat.fresh}`,
      `stale=${heartbeat.stale}`,
      `oldest=${formatAge(heartbeat.oldestAgeMs)}`,
    ].join(" ");
    if (heartbeat.total === 0 || heartbeat.fresh === 0) {
      add("worker-heartbeat", "fail", `${detail} (no fresh worker heartbeat)`);
    } else if (heartbeat.stale > 0 || heartbeat.truncated) {
      add(
        "worker-heartbeat",
        "warn",
        `${detail}${heartbeat.truncated ? " (bounded result)" : ""}`,
      );
    } else {
      add("worker-heartbeat", "pass", detail);
    }
  } catch {
    add("worker-heartbeat", "fail", "worker heartbeat state is unavailable");
  }

  try {
    const queue = await adapters.queueSummary();
    const detail = [
      `waiting=${queue.waiting}`,
      `active=${queue.active}`,
      `delayed=${queue.delayed}`,
      `completed=${queue.completed}`,
      `failed=${queue.failed}`,
      `oldest_waiting=${formatAge(queue.oldestWaitingAgeMs)}`,
      `oldest_delayed_created=${formatAge(queue.oldestDelayedCreationAgeMs)}`,
      `oldest_delayed_overdue=${formatAge(queue.oldestDelayedOverdueAgeMs)}`,
      `age_complete=${queue.waitingAgeComplete !== false && queue.delayedCreationAgeComplete !== false && queue.delayedDueAgeComplete !== false}`,
    ].join(" ");
    const ageIncomplete =
      queue.waitingAgeComplete === false ||
      queue.delayedCreationAgeComplete === false ||
      queue.delayedDueAgeComplete === false;
    const tooOld =
      (queue.oldestWaitingAgeMs !== null &&
        queue.oldestWaitingAgeMs > config.queueMaxWaitingAgeMs) ||
      (queue.oldestDelayedOverdueAgeMs !== null &&
        queue.oldestDelayedOverdueAgeMs > config.queueMaxWaitingAgeMs);
    add(
      "queue",
      ageIncomplete || tooOld ? "warn" : "pass",
      detail,
    );
  } catch {
    add("queue", "fail", "queue counts or age are unavailable");
  }

  try {
    const filesystems = await adapters.filesystemUsage();
    if (filesystems.length === 0) {
      add("filesystem", "fail", "no filesystem targets were checked");
    }
    for (const filesystem of filesystems) {
      const name = `filesystem:${safeLabel(filesystem.name)}`;
      if (!filesystem.available || filesystem.usedPercent === null) {
        add(
          name,
          filesystem.optional ? "warn" : "fail",
          filesystem.optional
            ? "optional filesystem usage is unavailable"
            : "required filesystem usage is unavailable",
        );
      } else if (filesystem.usedPercent >= config.diskCriticalPercent) {
        add(
          name,
          "fail",
          `used=${filesystem.usedPercent.toFixed(1)}% critical>=${config.diskCriticalPercent}%`,
        );
      } else if (filesystem.usedPercent >= config.diskWarningPercent) {
        add(
          name,
          "warn",
          `used=${filesystem.usedPercent.toFixed(1)}% warning>=${config.diskWarningPercent}%`,
        );
      } else {
        add(name, "pass", `used=${filesystem.usedPercent.toFixed(1)}%`);
      }
    }
  } catch {
    add("filesystem", "fail", "filesystem usage checks failed");
  }

  const overall = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";
  return { overall, exitCode: overall === "fail" ? 1 : 0, checks };
}

function safeLabel(value: string): string {
  const label = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  return label || "unknown";
}

export function formatProductionOpsReport(report: ProductionOpsReport): string {
  const labels: Record<OperationalStatus, string> = {
    pass: "PASS",
    warn: "WARN",
    fail: "FAIL",
  };
  return [
    "Sherlock production operations check",
    ...report.checks.map(
      (check) => `${labels[check.status]}  ${check.name}: ${check.detail}`,
    ),
    `OVERALL ${labels[report.overall]}`,
  ].join("\n");
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return "none";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s`;
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)}m`;
  if (ageMs < 24 * 60 * 60_000) {
    return `${Math.floor(ageMs / (60 * 60_000))}h`;
  }
  return `${Math.floor(ageMs / (24 * 60 * 60_000))}d`;
}
