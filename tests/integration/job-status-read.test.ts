import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { AttemptOutcome, JobStatus, JobType, type Prisma } from "@prisma/client";

import { db } from "../../lib/db/client";
import { getJobDetailForAccount } from "../../modules/jobs/get-job";

/**
 * PR-JOB-004: the polled status read.
 *
 * The test that matters most is the cross-account one. A status endpoint takes a
 * job id in the URL, and job ids are handed out to whoever enqueued a job, so
 * this is the exact surface where PR-AUTH-004 and AGENTS rule 2 are most likely
 * to be got wrong.
 */

const accountIds: string[] = [];

async function createAccount(): Promise<string> {
  const account = await db.account.create({
    data: { name: `status-${randomUUID()}` },
    select: { id: true },
  });
  accountIds.push(account.id);
  return account.id;
}

async function createJob(
  accountId: string,
  overrides: {
    status?: JobStatus;
    attempts?: number;
    result?: Prisma.InputJsonValue;
    lastError?: string | null;
  } = {},
): Promise<string> {
  const job = await db.job.create({
    data: {
      accountId,
      type: JobType.WEBHOOK_CALL,
      payload: { url: "https://example.com/hook" },
      result: overrides.result ?? undefined,
      idempotencyKey: randomUUID(),
      status: overrides.status ?? JobStatus.QUEUED,
      attempts: overrides.attempts ?? 0,
      lastError: overrides.lastError ?? null,
    },
    select: { id: true },
  });
  return job.id;
}

async function addAttempt(
  jobId: string,
  attemptNumber: number,
  outcome: AttemptOutcome,
  errorMessage: string | null,
): Promise<void> {
  await db.jobAttempt.create({
    data: {
      jobId,
      attemptNumber,
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(),
      durationMs: 1234,
      outcome,
      errorMessage,
    },
  });
}

before(async () => {
  await db.$connect();
});

after(async () => {
  await db.jobAttempt.deleteMany({});
  await db.jobOutput.deleteMany({});
  await db.job.deleteMany({});
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
  await db.$disconnect();
});

test("returns status, attempts, and payload for a fresh job", async () => {
  const accountId = await createAccount();
  const jobId = await createJob(accountId);

  const detail = await getJobDetailForAccount({ accountId, jobId });

  assert.ok(detail !== null);
  assert.equal(detail.job.id, jobId);
  assert.equal(detail.job.status, JobStatus.QUEUED);
  assert.equal(detail.job.attempts, 0);
  assert.deepEqual(detail.job.payload, { url: "https://example.com/hook" });
  assert.deepEqual(detail.attemptHistory, []);
});

test("surfaces the last error and the attempt count on a dead job", async () => {
  const accountId = await createAccount();
  const jobId = await createJob(accountId, {
    status: JobStatus.DEAD,
    attempts: 5,
    lastError: "upstream returned 500 five times",
  });

  const detail = await getJobDetailForAccount({ accountId, jobId });

  assert.ok(detail !== null);
  assert.equal(detail.job.status, JobStatus.DEAD);
  assert.equal(detail.job.attempts, 5);
  assert.equal(detail.job.lastError, "upstream returned 500 five times");
});

test("surfaces the result on a succeeded job", async () => {
  const accountId = await createAccount();
  const jobId = await createJob(accountId, {
    status: JobStatus.SUCCEEDED,
    attempts: 1,
    result: { statusCode: 200 },
  });

  const detail = await getJobDetailForAccount({ accountId, jobId });

  assert.ok(detail !== null);
  assert.equal(detail.job.status, JobStatus.SUCCEEDED);
  assert.deepEqual(detail.job.result, { statusCode: 200 });
});

test("returns the full attempt history in order, newest last", async () => {
  const accountId = await createAccount();
  const jobId = await createJob(accountId, { status: JobStatus.FAILED, attempts: 2 });
  await addAttempt(jobId, 2, AttemptOutcome.FAILED, "second attempt failed");
  await addAttempt(jobId, 1, AttemptOutcome.FAILED, "first attempt failed");

  const detail = await getJobDetailForAccount({ accountId, jobId });

  assert.ok(detail !== null);
  assert.equal(detail.attemptHistory.length, 2);
  assert.deepEqual(
    detail.attemptHistory.map((attempt) => attempt.attemptNumber),
    [1, 2],
  );
  assert.equal(detail.attemptHistory[0].errorMessage, "first attempt failed");
  assert.equal(detail.attemptHistory[1].errorMessage, "second attempt failed");
  assert.equal(detail.attemptHistory[0].outcome, AttemptOutcome.FAILED);
  assert.equal(detail.attemptHistory[0].durationMs, 1234);
});

test("keeps a prior attempt's record after a later one succeeds", async () => {
  // AGENTS rule 11: an attempt is never overwritten, so a job that failed then
  // succeeded still reports both.
  const accountId = await createAccount();
  const jobId = await createJob(accountId, {
    status: JobStatus.SUCCEEDED,
    attempts: 2,
    result: { statusCode: 200 },
  });
  await addAttempt(jobId, 1, AttemptOutcome.FAILED, "transient failure");
  await addAttempt(jobId, 2, AttemptOutcome.SUCCEEDED, null);

  const detail = await getJobDetailForAccount({ accountId, jobId });

  assert.ok(detail !== null);
  assert.equal(detail.attemptHistory.length, 2);
  assert.equal(detail.attemptHistory[0].outcome, AttemptOutcome.FAILED);
  assert.equal(detail.attemptHistory[1].outcome, AttemptOutcome.SUCCEEDED);
});

test("does not read another account's job", async () => {
  const mine = await createAccount();
  const theirs = await createAccount();
  const theirJobId = await createJob(theirs, {
    status: JobStatus.DEAD,
    lastError: "another account's failure",
  });

  // The id is known here, which is exactly the case PR-AUTH-004 calls out.
  const detail = await getJobDetailForAccount({ accountId: mine, jobId: theirJobId });

  assert.equal(detail, null, "a job owned by another account must read as absent");
});

test("an absent job and a forbidden job are indistinguishable", async () => {
  // Both are null, so the route can answer both with the same 404 and cannot be
  // used to discover which job ids exist.
  const mine = await createAccount();
  const theirs = await createAccount();
  const theirJobId = await createJob(theirs);

  const forbidden = await getJobDetailForAccount({ accountId: mine, jobId: theirJobId });
  const absent = await getJobDetailForAccount({ accountId: mine, jobId: randomUUID() });

  assert.equal(forbidden, null);
  assert.equal(absent, null);
});

test("an id that is not a job id at all reads as absent", async () => {
  const accountId = await createAccount();

  const detail = await getJobDetailForAccount({ accountId, jobId: "not-a-real-id" });

  assert.equal(detail, null);
});

test("the attempt history never includes another job's attempts", async () => {
  const accountId = await createAccount();
  const jobId = await createJob(accountId);
  const otherJobId = await createJob(accountId);
  await addAttempt(otherJobId, 1, AttemptOutcome.FAILED, "belongs to a different job");

  const detail = await getJobDetailForAccount({ accountId, jobId });

  assert.ok(detail !== null);
  assert.deepEqual(detail.attemptHistory, []);
});
