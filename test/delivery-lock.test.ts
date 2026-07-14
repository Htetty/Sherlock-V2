import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createFileDeliveryStateStore,
  DELIVERY_LOCK_TTL_MS,
  DeliveryLockBusyError,
  DeliveryLockLostError,
  type DeliveryLockLease,
} from "../backend/services/delivery.js";
import {
  DELIVERY_JOB_ATTEMPTS,
  DELIVERY_RETRY_BACKOFF_MS,
} from "../backend/queue/investigation-queue.js";

const INV = "inv_0LOCKRECOVER1";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root() {
  const value = await mkdtemp(path.join(tmpdir(), "sherlock-lock-"));
  roots.push(value);
  return value;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("crash-recoverable delivery lease", () => {
  test("a crashed owner expires, a new owner recovers, and the stale owner is fenced", async () => {
    const artifacts = await root();
    let clock = 0;
    const oldStore = createFileDeliveryStateStore(artifacts, {
      ttlMs: 20,
      heartbeatMs: 0,
      now: () => clock,
    });
    const newStore = createFileDeliveryStateStore(artifacts, {
      ttlMs: 20,
      heartbeatMs: 0,
      now: () => clock,
    });
    const oldStarted = deferred();
    const resumeOld = deferred();
    let oldLease!: DeliveryLockLease;
    let externalSideEffects = 0;

    const oldAttempt = oldStore.withLock(INV, async (lease) => {
      oldLease = lease;
      oldStarted.resolve();
      await resumeOld.promise;
      await lease.assertOwned();
      externalSideEffects += 1;
    });
    await oldStarted.promise;
    expect(oldLease.token).toMatch(/^[0-9a-f-]{36}$/);

    clock = 21;
    const newStarted = deferred();
    const releaseNew = deferred();
    let newToken = "";
    const recovered = newStore.withLock(INV, async (lease) => {
      newToken = lease.token;
      externalSideEffects += 1;
      newStarted.resolve();
      await releaseNew.promise;
      await lease.assertOwned();
    });
    await newStarted.promise;
    expect(newToken).not.toBe(oldLease.token);

    resumeOld.resolve();
    await expect(oldAttempt).rejects.toBeInstanceOf(DeliveryLockLostError);

    // The stale owner's compare-and-delete release cannot remove the current
    // owner's lease while that owner is still working.
    const ownerPath = path.join(
      artifacts,
      "_delivery-locks",
      `${INV}.lock`,
      "owner",
    );
    await expect(readFile(ownerPath, "utf8")).resolves.toBe(newToken);
    expect(externalSideEffects).toBe(1);

    releaseNew.resolve();
    await recovered;
  });

  test("only the owner can renew and renewal prevents stale reclamation", async () => {
    const artifacts = await root();
    let clock = 0;
    const owner = createFileDeliveryStateStore(artifacts, {
      ttlMs: 20,
      heartbeatMs: 0,
      now: () => clock,
    });
    const contender = createFileDeliveryStateStore(artifacts, {
      ttlMs: 20,
      heartbeatMs: 0,
      now: () => clock,
    });
    const started = deferred();
    const release = deferred();
    const active = owner.withLock(INV, async (lease) => {
      clock = 15;
      await lease.renew();
      started.resolve();
      await release.promise;
    });
    await started.promise;

    clock = 30;
    await expect(
      contender.withLock(INV, async () => {}),
    ).rejects.toBeInstanceOf(DeliveryLockBusyError);

    release.resolve();
    await active;
  });

  test("the delivery retry horizon outlives an unrenewed production lease", () => {
    const retryDelays = Array.from(
      { length: DELIVERY_JOB_ATTEMPTS - 1 },
      (_, index) => DELIVERY_RETRY_BACKOFF_MS * 2 ** index,
    );
    expect(DELIVERY_RETRY_BACKOFF_MS).toBeGreaterThan(DELIVERY_LOCK_TTL_MS);
    expect(retryDelays.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(
      DELIVERY_LOCK_TTL_MS,
    );
  });
});
