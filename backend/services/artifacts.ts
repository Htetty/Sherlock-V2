// Investigation IDs and persisted artifact storage under artifacts/<id>/.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReproductionResult } from "./playwright.js";

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_PATTERN = /^inv_[0-9A-Z]{10,}$/;
const FIX_ATTEMPT_ID_PATTERN = /^fix_[0-9A-Z]{10,}$/;

function createId(prefix: string) {
  const time = Date.now().toString(32).toUpperCase().padStart(9, "0");
  let random = "";

  for (const byte of randomBytes(6)) {
    random += ID_ALPHABET[byte % ID_ALPHABET.length];
  }

  return `${prefix}_${time}${random}`;
}

export function createInvestigationId() {
  return createId("inv");
}

export function createFixAttemptId() {
  return createId("fix");
}

export function isFixAttemptId(value: unknown): value is string {
  return typeof value === "string" && FIX_ATTEMPT_ID_PATTERN.test(value);
}

export function isInvestigationId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function getArtifactsRoot() {
  return process.env.ARTIFACTS_DIR ?? path.resolve("artifacts");
}

export type ArtifactStore = {
  investigationId: string;
  dir: string;
  screenshotsDir: string;
  writeJson: (fileName: string, value: unknown) => Promise<string>;
};

export async function createArtifactStore(
  investigationId: string,
  baseDir?: string,
): Promise<ArtifactStore> {
  const dir = baseDir ?? path.join(getArtifactsRoot(), investigationId);
  const screenshotsDir = path.join(dir, "screenshots");

  await mkdir(screenshotsDir, { recursive: true });

  return {
    investigationId,
    dir,
    screenshotsDir,
    writeJson: async (fileName, value) => {
      const filePath = path.join(dir, fileName);
      await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      return filePath;
    },
  };
}

export async function createReplayStore(investigationDir: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const investigationId = path.basename(investigationDir);
  const replayDir = path.join(investigationDir, "replays", timestamp);

  return createArtifactStore(investigationId, replayDir);
}

export async function readJsonArtifact(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

// Persist the standard evidence files produced by a plan execution.
export async function writeExecutionArtifacts(
  store: ArtifactStore,
  result: ReproductionResult,
) {
  await store.writeJson("reproduction-result.json", {
    investigationId: store.investigationId,
    ...result,
  });
  await store.writeJson("playwright-events.json", result.events);
  await store.writeJson("console-errors.json", {
    consoleErrors: result.consoleErrors,
    pageErrors: result.pageErrors,
  });
  await store.writeJson("network-failures.json", result.networkFailures);
}
