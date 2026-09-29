import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { JobStatus, JobType } from "@prisma/client";

import { db } from "../../lib/db/client";
import { DEAD_JOB_PAGE_SIZE, listDeadJobsForAccount } from "../../modules/jobs/list-dead-jobs";

/**
 * The read-only dead-letter listing. Requires a reachable PostgreSQL.
 *
 * The test that matters most here is the cross-account one: PR-AUTH-004 and
 * AGENTS rule 2 forbid one account reading another's jobs even when the job id is
 * known, and a dead-letter view is exactly the surface where that would leak.
 */

const accountIds: string[] = [];

async function createAccount(): Promise<string> {
  const account = await db.account.create({
    data: { name: `dlq-${randomUUID()}` },
    select: { id: true },
  });
  accountIds.push(account.id);
  return account.id;
}

async function createDeadJob(
  accountId: string,
  overrides: { status?: JobStatus; lastError?: string | null } = {},
): Promise<string> {
  const job = await db.job.create({
    data: {
      accountId,
      type: JobType.WEBHOOK_CALL,
      payload: { url: "https://example.com/hook", n: 1 },
      idempotencyKey: randomUUID(),
      status: overrides.status ?? JobStatus.DEAD,
      attempts: 5,
      maxAttempts: 5,
        // `!== undefined`, not `??`: a caller passing an explicit `null` means
        // "this job has no error", which is exactly what one test asserts.
        lastError:
          overrides.lastError === undefined
            ? "upstream returned 500 five times"
            : overrides.lastError,
      finishedAt: new Date(),
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
  await db.jobOutput.deleteMany({});
  await db.job.deleteMany({});
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
  await db.$disconnect();
});

test("lists a dead job with its payload and last error", async () => {
  const accountId = await createAccount();
  const jobId = await createDeadJob(accountId);

  const listing = await listDeadJobsForAccount(accountId);

  assert.equal(listing.jobs.length, 1);
  const job = listing.jobs[0];
  assert.equal(job.id, jobId);
  assert.equal(job.type, JobType.WEBHOOK_CALL);
  assert.equal(job.lastError, "upstream returned 500 five times");
  assert.deepEqual(job.payload, { url: "https://example.com/hook", n: 1 });
  assert.equal(job.attempts, 5);
  assert.equal(job.maxAttempts, 5);
  assert.ok(job.finishedAt !== null);
});

test("does not leak another account's dead jobs", async () => {
  const mine = await createAccount();
  const theirs = await createAccount();
  await createDeadJob(theirs, { lastError: "a secret failure another account can see" });

  const listing = await listDeadJobsForAccount(mine);

  assert.equal(listing.jobs.length, 0);
  assert.equal(listing.totalDead, 0);
  for (const job of listing.jobs) {
    assert.ok(!job.lastError?.includes("another account"), "cross-account leak");
  }
});

test("counts only the calling account's dead jobs", async () => {
  const mine = await createAccount();
  const theirs = await createAccount();
  await createDeadJob(mine);
  await createDeadJob(mine);
  await createDeadJob(theirs);
  await createDeadJob(theirs);

  const listing = await listDeadJobsForAccount(mine);

  assert.equal(listing.jobs.length, 2);
  assert.equal(listing.totalDead, 2, "another account's dead jobs must not be counted");
});

test("excludes jobs that are not dead", async () => {
  const accountId = await createAccount();
  await createDeadJob(accountId);
  await createDeadJob(accountId, { status: JobStatus.FAILED, lastError: "waiting to retry" });
  await createDeadJob(accountId, { status: JobStatus.SUCCEEDED, lastError: null });
  await createDeadJob(accountId, { status: JobStatus.QUEUED, lastError: null });
  await createDeadJob(accountId, { status: JobStatus.PROCESSING, lastError: null });

  const listing = await listDeadJobsForAccount(accountId);

  assert.equal(listing.totalDead, 1);
  assert.ok(listing.jobs.every((job) => job.lastError !== "waiting to retry"));
});

test("reports a job with no recorded error rather than omitting it", async () => {
  const accountId = await createAccount();
  await createDeadJob(accountId, { lastError: null });

  const listing = await listDeadJobsForAccount(accountId);

  assert.equal(listing.jobs.length, 1);
  assert.equal(listing.jobs[0].lastError, null);
});

test("most recent dead job is listed first", async () => {
  const accountId = await createAccount();
  const older = await createDeadJob(accountId);
  const newer = await createDeadJob(accountId);
  await db.job.update({ where: { id: older }, data: { finishedAt: new Date("2026-01-01T00:00:00Z") } });
  await db.job.update({ where: { id: newer }, data: { finishedAt: new Date("2026-02-01T00:00:00Z") } });

  const listing = await listDeadJobsForAccount(accountId);

  assert.equal(listing.jobs[0].id, newer);
});

test("caps the page but still reports the true total", async () => {
  const accountId = await createAccount();
  const total = DEAD_JOB_PAGE_SIZE + 5;
  for (let index = 0; index < total; index += 1) {
    await createDeadJob(accountId);
  }

  const listing = await listDeadJobsForAccount(accountId);

  assert.equal(listing.jobs.length, DEAD_JOB_PAGE_SIZE, "page must be capped");
  assert.equal(listing.totalDead, total, "the uncapped total must still be reported");
  assert.equal(listing.pageSize, DEAD_JOB_PAGE_SIZE);
});

test("an account with nothing dead gets an empty listing, not an error", async () => {
  const accountId = await createAccount();

  const listing = await listDeadJobsForAccount(accountId);

  assert.deepEqual(listing.jobs, []);
  assert.equal(listing.totalDead, 0);
});
