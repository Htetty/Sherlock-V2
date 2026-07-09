// Investigation state store: a small, dashboard-friendly record of an
// investigation's lifecycle, kept separate from the rich per-investigation
// artifacts under artifacts/<id>/.
//
// This is the first slice: a typed interface plus in-memory, file, and no-op
// implementations. There is intentionally NO Supabase/Postgres backend yet —
// the interface is the seam a persistent store will later implement.
//
// Design contract:
//   - Injectable/testable: the pipeline takes a store via PipelineOptions and
//     defaults to the no-op store, so wiring it in changes nothing unless a
//     real store is supplied.
//   - Non-fatal: callers must treat state writes as best-effort. The pipeline
//     wraps every record() call and swallows failures (see runInvestigation
//     pipeline's recordState helper); an implementation may throw freely.
//   - No secrets: only stable IDs, coarse status, and already-safe summary
//     fields are stored. Free-text error/reason fields are passed through
//     redactSecrets() before they are persisted.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getArtifactsRoot, isInvestigationId } from "./artifacts.js";
import { redactSecrets } from "./report.js";
import type { InvestigationStage } from "./investigation.js";

// --- Lifecycle events -----------------------------------------------------
// One discriminated union covers every lifecycle write. Keeping a single
// record(event) entry point (rather than one method per event) keeps the
// interface tiny and makes a future persistent implementation a single switch.

export type ReproductionPath =
  | "memory_replay"
  | "one_shot"
  | "reproducer_agent";

export type InvestigationStateEvent =
  | {
      type: "created";
      investigationId: string;
      at: string;
      repoOwner?: string;
      repoName?: string;
      repoUrl?: string;
      issueNumber?: number;
      issueTitle?: string;
      issueUrl?: string;
      triggeredBy?: string;
    }
  | {
      type: "stage_changed";
      investigationId: string;
      at: string;
      stage: InvestigationStage;
    }
  | {
      type: "reproduction";
      investigationId: string;
      at: string;
      path: ReproductionPath | null;
      mode: string | null;
      outcome: string;
      commit?: string;
    }
  | {
      type: "fixer_attempts";
      investigationId: string;
      at: string;
      status: string | null;
      attempts: number;
      outcome: string | null;
      changedFiles: string[];
      verifiedFixAttemptId: string | null;
    }
  | {
      type: "repository_validation";
      investigationId: string;
      at: string;
      aggregate: string;
      categories: { category: string; status: string }[];
    }
  | {
      type: "regression_proof";
      investigationId: string;
      at: string;
      status: string;
      testName: string | null;
      prePatch: string | null;
      postPatch: string | null;
      hashMatched: boolean | null;
    }
  | {
      type: "pull_request";
      investigationId: string;
      at: string;
      status: string;
      number: number | null;
      url: string | null;
      branch: string | null;
    }
  | {
      type: "final_outcome";
      investigationId: string;
      at: string;
      outcome: string;
      originalOutcome?: string | null;
      pullRequestStatus?: string | null;
      error?: string | null;
    }
  | {
      type: "error";
      investigationId: string;
      at: string;
      stage: string | null;
      message: string;
      // True when the error is a transient/retryable infrastructure failure
      // the job will retry (no terminal outcome recorded yet).
      retryable?: boolean;
    };

// A lifecycle event with the fields the pipeline fills in for every event
// (investigationId, at) omitted. Distributive so each union member keeps its
// own properties (a plain Omit over a union collapses to shared fields only).
export type InvestigationStateEventInput = InvestigationStateEvent extends infer T
  ? T extends InvestigationStateEvent
    ? Omit<T, "investigationId" | "at">
    : never
  : never;

// --- Aggregate record (what a dashboard reads) ----------------------------

export type InvestigationStateRecord = {
  investigationId: string;
  createdAt: string | null;
  updatedAt: string;
  status: "running" | "finished";
  stage: InvestigationStage | null;
  repoOwner?: string;
  repoName?: string;
  repoUrl?: string;
  issueNumber?: number;
  issueTitle?: string;
  issueUrl?: string;
  triggeredBy?: string;
  commit?: string;
  reproduction: {
    path: ReproductionPath | null;
    mode: string | null;
    outcome: string;
  } | null;
  fixer: {
    status: string | null;
    attempts: number;
    outcome: string | null;
    changedFiles: string[];
    verifiedFixAttemptId: string | null;
  } | null;
  repositoryValidation: {
    aggregate: string;
    categories: { category: string; status: string }[];
  } | null;
  regressionProof: {
    status: string;
    testName: string | null;
    prePatch: string | null;
    postPatch: string | null;
    hashMatched: boolean | null;
  } | null;
  pullRequest: {
    status: string;
    number: number | null;
    url: string | null;
    branch: string | null;
  } | null;
  outcome: string | null;
  finishedAt: string | null;
  errors: {
    at: string;
    stage: string | null;
    message: string;
    retryable?: boolean;
  }[];
};

// --- Interface ------------------------------------------------------------

export interface InvestigationStateStore {
  // Apply a single lifecycle event. May throw; callers treat writes as
  // best-effort and must not fail the investigation on error.
  record(event: InvestigationStateEvent): Promise<void>;
  // Read helpers used by tests today and a dashboard later; optional so the
  // no-op store can omit them.
  get?(investigationId: string): Promise<InvestigationStateRecord | null>;
  list?(): Promise<InvestigationStateRecord[]>;
}

function emptyRecord(
  investigationId: string,
  at: string,
): InvestigationStateRecord {
  return {
    investigationId,
    createdAt: null,
    updatedAt: at,
    status: "running",
    stage: null,
    reproduction: null,
    fixer: null,
    repositoryValidation: null,
    regressionProof: null,
    pullRequest: null,
    outcome: null,
    finishedAt: null,
    errors: [],
  };
}

// Defensive sanitizer for every free-text string that reaches the record.
// redactSecrets scrubs tokens/credentials/secret-shaped assignments; anything
// stored from user- or webhook-controlled text passes through here so no store
// can persist a secret regardless of backend.
function safeText(value: string): string {
  return redactSecrets(value);
}

// Pure reducer shared by every implementation: fold one event into the
// aggregate. Free-text fields are redacted here so no store can persist a
// secret that slipped through, regardless of backend.
export function applyEvent(
  previous: InvestigationStateRecord | null,
  event: InvestigationStateEvent,
): InvestigationStateRecord {
  const record = previous
    ? { ...previous }
    : emptyRecord(event.investigationId, event.at);

  record.updatedAt = event.at;

  switch (event.type) {
    case "created":
      record.createdAt = event.at;
      if (event.repoOwner !== undefined) record.repoOwner = safeText(event.repoOwner);
      if (event.repoName !== undefined) record.repoName = safeText(event.repoName);
      if (event.repoUrl !== undefined) record.repoUrl = safeText(event.repoUrl);
      if (event.issueNumber !== undefined) record.issueNumber = event.issueNumber;
      if (event.issueTitle !== undefined) record.issueTitle = safeText(event.issueTitle);
      if (event.issueUrl !== undefined) record.issueUrl = safeText(event.issueUrl);
      if (event.triggeredBy !== undefined) record.triggeredBy = safeText(event.triggeredBy);
      break;
    case "stage_changed":
      record.stage = event.stage;
      break;
    case "reproduction":
      record.reproduction = {
        path: event.path,
        mode: event.mode,
        outcome: event.outcome,
      };
      if (event.commit !== undefined) record.commit = event.commit;
      break;
    case "fixer_attempts":
      record.fixer = {
        status: event.status,
        attempts: event.attempts,
        outcome: event.outcome,
        changedFiles: event.changedFiles,
        verifiedFixAttemptId: event.verifiedFixAttemptId,
      };
      break;
    case "repository_validation":
      record.repositoryValidation = {
        aggregate: event.aggregate,
        categories: event.categories,
      };
      break;
    case "regression_proof":
      record.regressionProof = {
        status: event.status,
        testName: event.testName,
        prePatch: event.prePatch,
        postPatch: event.postPatch,
        hashMatched: event.hashMatched,
      };
      break;
    case "pull_request":
      record.pullRequest = {
        status: event.status,
        number: event.number,
        url: event.url,
        branch: event.branch,
      };
      break;
    case "final_outcome":
      record.status = "finished";
      record.finishedAt = event.at;
      record.outcome = event.outcome;
      if (event.error != null) {
        record.errors = [
          ...record.errors,
          { at: event.at, stage: "final", message: redactSecrets(event.error) },
        ];
      }
      break;
    case "error":
      record.errors = [
        ...record.errors,
        {
          at: event.at,
          stage: event.stage,
          message: redactSecrets(event.message),
          ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
        },
      ];
      break;
  }

  return record;
}

// Build a safe canonical GitHub repository URL from the already-validated
// owner and name, rather than storing any caller-supplied URL that could carry
// embedded credentials. The components are additionally redacted defensively.
export function safeRepoUrl(owner: string, name: string): string {
  return `https://github.com/${safeText(owner)}/${safeText(name)}`;
}

// --- No-op store ----------------------------------------------------------
// The default. Records nothing; guarantees wiring the store in never changes
// investigation behavior until a real store is supplied.

export function createNoopInvestigationStateStore(): InvestigationStateStore {
  return {
    async record() {
      // Intentionally does nothing.
    },
  };
}

// --- In-memory store ------------------------------------------------------
// For tests and short-lived dev processes; loses state on restart.

export function createInMemoryInvestigationStateStore(): InvestigationStateStore & {
  snapshot(): InvestigationStateRecord[];
} {
  const records = new Map<string, InvestigationStateRecord>();

  return {
    async record(event) {
      records.set(
        event.investigationId,
        applyEvent(records.get(event.investigationId) ?? null, event),
      );
    },
    async get(investigationId) {
      return records.get(investigationId) ?? null;
    },
    async list() {
      return [...records.values()];
    },
    snapshot() {
      return [...records.values()];
    },
  };
}

// --- File store -----------------------------------------------------------
// One JSON file per investigation under <root>/<id>.json. Read-merge-write is
// safe because a single investigation's events are applied sequentially by the
// pipeline (it awaits each record() call).

export function getStateStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.SHERLOCK_STATE_STORE_DIR ?? path.join(getArtifactsRoot(), "_state")
  );
}

// Resolve a state file path for an investigation id, refusing anything that is
// not a well-formed investigation id (isInvestigationId is a strict allowlist:
// ^inv_[0-9A-Z]{10,}$, so slashes, dots, "..", and other unsafe characters are
// rejected). A path.resolve containment check is kept as defense-in-depth in
// case the id pattern is ever loosened.
export function resolveStateFilePath(
  rootDir: string,
  investigationId: string,
): string {
  if (!isInvestigationId(investigationId)) {
    throw new Error("Refusing state-store path for unsafe investigation id.");
  }

  const resolvedRoot = path.resolve(rootDir);
  const expected = path.join(resolvedRoot, `${investigationId}.json`);
  const resolved = path.resolve(resolvedRoot, `${investigationId}.json`);

  if (resolved !== expected || !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error("State-store path escaped the root directory.");
  }

  return resolved;
}

export function createFileInvestigationStateStore(
  rootDir: string = getStateStoreRoot(),
): InvestigationStateStore {
  const filePathFor = (investigationId: string) =>
    resolveStateFilePath(rootDir, investigationId);

  const readRecord = async (
    investigationId: string,
  ): Promise<InvestigationStateRecord | null> => {
    try {
      const raw = await readFile(filePathFor(investigationId), "utf8");
      return JSON.parse(raw) as InvestigationStateRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };

  return {
    async record(event) {
      await mkdir(rootDir, { recursive: true });
      const next = applyEvent(await readRecord(event.investigationId), event);
      await writeFile(
        filePathFor(event.investigationId),
        `${JSON.stringify(next, null, 2)}\n`,
        "utf8",
      );
    },
    async get(investigationId) {
      return readRecord(investigationId);
    },
    async list() {
      let names: string[];
      try {
        names = await readdir(rootDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }

      const records: InvestigationStateRecord[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) {
          continue;
        }
        const id = name.slice(0, -".json".length);
        // Only read files whose name is a valid investigation id; ignore any
        // stray/unsafe file the store never wrote.
        if (!isInvestigationId(id)) {
          continue;
        }
        const record = await readRecord(id);
        if (record) {
          records.push(record);
        }
      }
      return records;
    },
  };
}

// Environment-driven factory used by the worker and HTTP server. Defaults to
// the no-op store so production behavior is unchanged until state persistence
// is explicitly enabled with SHERLOCK_STATE_STORE=file.
export function createInvestigationStateStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): InvestigationStateStore {
  if (env.SHERLOCK_STATE_STORE === "file") {
    return createFileInvestigationStateStore(getStateStoreRoot(env));
  }

  return createNoopInvestigationStateStore();
}
