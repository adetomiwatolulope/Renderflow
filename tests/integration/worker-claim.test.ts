import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { JobType } from "@prisma/client";

import { db } from "../../lib/db/client";
import { claimNextJob } from "../../modules/queue/claim";
import { markJobSucceeded, settleAttemptFailure } from "../../modules/queue/settle";
import { executableJobTypes } from "../../worker/executors/registry";

/**
 * Step 3's central claim: two workers must never pick up the same job.
 * Requires a reachable PostgreSQL (PR-TECH-001 is Postgres-only).
 */

const accountIds: string[] = [];

async function createAccount(): Promise<string> {
  const account = await db.account.create({
    data: { name: `test-${randomUUID()}` },
    select: { id: true },
  });
  accountIds.push(account.id);
  return account.id;
}

async function createQueuedJob(type: JobType = JobType.WEBHOOK_CALL): Promise<string> {
  const accountId = await createAccount();
  const job = await db.job.create({
    data: {
      accountId,
      type,
      payload: { url: "https://example.com/hook" },
      idempotencyKey: randomUUID(),
    },
    select: { id: true },
  });
  return job.id;
}

before(async () => {
  await db.$connect();
});

after(async () => {
  await db.jobAttempt.deleteMany({});
  await db.job.deleteMany({});
  await db.apiKey.deleteMany({});
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
  await db.$disconnect();
});

test("a claim marks the job PROCESSING, increments attempts, and sets startedAt", async () => {
  const jobId = await createQueuedJob();
  const types = executableJobTypes();

  const claimed = await claimNextJob(types);
  assert.ok(claimed, "expected a job to be claimable");
  assert.equal(claimed.id, jobId);
  assert.equal(claimed.attempts, 1);

  const stored = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  assert.equal(stored.status, "PROCESSING");
  assert.equal(stored.attempts, 1);
  assert.ok(stored.startedAt !== null);
});

test("a claimed job is not claimable again", async () => {
  await createQueuedJob();
  const types = executableJobTypes();

  const first = await claimNextJob(types);
  assert.ok(first);
  const second = await claimNextJob(types);
  assert.ok(second);
  assert.notEqual(second.id, first.id, "PROCESSING job must not be re-claimable");
});

// The race: many workers all reach for the same single pending job at once.
test("many concurrent claims of one job produce exactly one winner", async () => {
  const jobId = await createQueuedJob();
  const types = executableJobTypes();

  const results = await Promise.all(
    Array.from({ length: 10 }, () => claimNextJob(types)),
  );

  const winners = results.filter((claimed) => claimed?.id === jobId);
  assert.equal(winners.length, 1, "exactly one worker may win the claim");

  const stored = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  assert.equal(stored.attempts, 1, "a lost race must not increment attempts");
  assert.equal(stored.status, "PROCESSING");
});

test("a job whose type has no executor is never claimed", async () => {
  await createQueuedJob(JobType.CUSTOM);

  const claimed = await claimNextJob(executableJobTypes());
  assert.equal(claimed, null);

  const stuck = await db.job.findFirstOrThrow({ where: { type: JobType.CUSTOM } });
  assert.equal(stuck.status, "QUEUED", "an unexecutable job must stay QUEUED, not burn attempts");
  assert.equal(stuck.attempts, 0);
});

test("a job scheduled for the future is not claimed", async () => {
  const accountId = await createAccount();
  await db.job.create({
    data: {
      accountId,
      type: JobType.WEBHOOK_CALL,
      payload: { url: "https://example.com/hook" },
      idempotencyKey: randomUUID(),
      runAt: new Date(Date.now() + 60_000),
    },
  });

  assert.equal(await claimNextJob(executableJobTypes()), null);
});

test("a FAILED job whose backoff has elapsed is claimable again", async () => {
  const jobId = await createQueuedJob();
  const types = executableJobTypes();

  const first = await claimNextJob(types);
  assert.ok(first);

  await settleAttemptFailure(first, {
    retryable: true,
    errorCode: "NETWORK_ERROR",
    errorMessage: "boom",
  });

  const resting = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  assert.equal(resting.status, "FAILED");
  assert.ok(resting.runAt !== null, "a resting retry must be scheduled");
  assert.equal(
    await claimNextJob(types),
    null,
    "a FAILED job must not be claimable before its runAt",
  );

  await db.job.update({ where: { id: jobId }, data: { runAt: new Date(Date.now() - 1000) } });
  const reclaimed = await claimNextJob(types);
  assert.equal(reclaimed?.id, jobId);
  assert.equal(reclaimed?.attempts, 2, "a retry increments the attempt count");
});

test("success settles the job and records the attempt", async () => {
  const jobId = await createQueuedJob();
  const claimed = await claimNextJob(executableJobTypes());
  assert.ok(claimed);

  await markJobSucceeded(claimed, { statusCode: 200 });

  const stored = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  assert.equal(stored.status, "SUCCEEDED");
  assert.ok(stored.finishedAt !== null);
  assert.deepEqual(stored.result, { statusCode: 200 });

  const attempt = await db.jobAttempt.findFirstOrThrow({ where: { jobId } });
  assert.equal(attempt.attemptNumber, 1);
  assert.equal(attempt.outcome, "SUCCEEDED");
});

// AGENTS rule 6: terminal means terminal.
test("a terminal job cannot be settled again", async () => {
  const jobId = await createQueuedJob();
  const claimed = await claimNextJob(executableJobTypes());
  assert.ok(claimed);
  await markJobSucceeded(claimed, { statusCode: 200 });

  await assert.rejects(() =>
    markJobSucceeded(claimed, { statusCode: 200 }),
  );

  const stored = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  assert.equal(stored.status, "SUCCEEDED");
  assert.equal(
    await db.jobAttempt.count({ where: { jobId } }),
    1,
    "a refused settle must not add an attempt row",
  );
});

// AGENTS rule 11: every attempt keeps its own row.
test("a retry adds a new attempt row rather than overwriting the last", async () => {
  const jobId = await createQueuedJob();
  const types = executableJobTypes();

  const first = await claimNextJob(types);
  assert.ok(first);
  await settleAttemptFailure(first, {
    retryable: true,
    errorCode: "HTTP_500",
    errorMessage: "server error",
  });

  await db.job.update({ where: { id: jobId }, data: { runAt: new Date(Date.now() - 1000) } });
  const second = await claimNextJob(types);
  assert.ok(second);
  await markJobSucceeded(second, { statusCode: 204 });

  const attempts = await db.jobAttempt.findMany({
    where: { jobId },
    orderBy: { attemptNumber: "asc" },
  });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].attemptNumber, 1);
  assert.equal(attempts[0].outcome, "FAILED");
  assert.equal(attempts[0].errorCode, "HTTP_500");
  assert.equal(attempts[1].attemptNumber, 2);
  assert.equal(attempts[1].outcome, "SUCCEEDED");
});

// Exhausting maxAttempts finishes the job instead of resting forever.
test("the last permitted attempt finishes the job as DEAD", async () => {
  const accountId = await createAccount();
  const { id: jobId } = await db.job.create({
    data: {
      accountId,
      type: JobType.WEBHOOK_CALL,
      payload: { url: "https://example.com/hook" },
      idempotencyKey: randomUUID(),
      maxAttempts: 1,
    },
    select: { id: true },
  });

  const claimed = await claimNextJob(executableJobTypes());
  assert.ok(claimed);
  const status = await settleAttemptFailure(claimed, {
    retryable: true,
    errorCode: "NETWORK_ERROR",
    errorMessage: "boom",
  });

  assert.equal(status, "DEAD");
  const stored = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  assert.equal(stored.status, "DEAD");
  assert.equal(stored.runAt, null, "a finished job must not be rescheduled");
  assert.ok(stored.finishedAt !== null);
});

// PR-RETRY-002: a non-retryable failure does not wait for attempts to run out.
test("a non-retryable failure finishes the job immediately", async () => {
  const { id: jobId } = await db.job.create({
    data: {
      accountId: await createAccount(),
      type: JobType.WEBHOOK_CALL,
      payload: { url: "http://example.com/hook" },
      idempotencyKey: randomUUID(),
    },
    select: { id: true },
  });

  const claimed = await claimNextJob(executableJobTypes());
  assert.ok(claimed);
  const status = await settleAttemptFailure(claimed, {
    retryable: false,
    errorCode: "INSECURE_URL",
    errorMessage: "payload.url must use https",
  });

  assert.equal(status, "DEAD");
  const stored = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  assert.equal(stored.status, "DEAD");
});
