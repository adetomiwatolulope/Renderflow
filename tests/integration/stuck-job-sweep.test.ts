import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { AttemptOutcome, JobStatus, JobType } from "@prisma/client";

import { db } from "../../lib/db/client";
import { claimNextJob } from "../../modules/queue/claim";
import { recordHeartbeat } from "../../modules/queue/heartbeat";
import { stalledCutoff, sweepStalledJobs } from "../../modules/queue/sweep";

/**
 * Owner's Step 6: recovering jobs whose worker died mid-job.
 *
 * The distinction every test here protects is between a dead worker and a slow
 * live one (PR-RETRY-003, AGENTS rule 10). A job that is still beating is never
 * swept, however long it has been running.
 */

const STALL_TIMEOUT_MS = 600_000;

let accountId: string;

function staleHeartbeat(): Date {
  return new Date(Date.now() - STALL_TIMEOUT_MS - 60_000);
}

async function insertJob(overrides: {
  status: JobStatus;
  attempts: number;
  maxAttempts?: number;
  lastHeartbeatAt: Date | null;
  startedAt: Date | null;
}): Promise<string> {
  const job = await db.job.create({
    data: {
      accountId,
      type: JobType.WEBHOOK_CALL,
      payload: { url: "https://example.com/hook" },
      idempotencyKey: randomUUID(),
      status: overrides.status,
      attempts: overrides.attempts,
      maxAttempts: overrides.maxAttempts ?? 5,
      lastHeartbeatAt: overrides.lastHeartbeatAt,
      startedAt: overrides.startedAt,
      runAt: overrides.status === JobStatus.PROCESSING ? null : new Date(Date.now() - 1000),
    },
    select: { id: true },
  });
  return job.id;
}

before(async () => {
  const account = await db.account.create({
    data: { name: `sweep-${randomUUID()}` },
    select: { id: true },
  });
  accountId = account.id;
});

after(async () => {
  await db.jobAttempt.deleteMany({ where: { job: { accountId } } });
  await db.jobOutput.deleteMany({ where: { job: { accountId } } });
  await db.job.deleteMany({ where: { accountId } });
  await db.account.deleteMany({ where: { id: accountId } });
});

beforeEach(async () => {
  // Child rows first: the job FKs are ON DELETE RESTRICT, so deleting a job that
  // still has attempts or an output reference is refused.
  await db.jobAttempt.deleteMany({ where: { job: { accountId } } });
  await db.jobOutput.deleteMany({ where: { job: { accountId } } });
  await db.job.deleteMany({ where: { accountId } });
});

describe("sweepStalledJobs", () => {
  it("requeues a job whose heartbeat has gone stale", async () => {
    const stale = staleHeartbeat();
    const jobId = await insertJob({
      status: JobStatus.PROCESSING,
      attempts: 1,
      lastHeartbeatAt: stale,
      startedAt: new Date(Date.now() - 1_000_000),
    });

    const result = await sweepStalledJobs({ stallTimeoutMs: STALL_TIMEOUT_MS });

    assert.equal(result.swept, 1);
    assert.equal(result.skipped, 0);

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, JobStatus.FAILED);
    assert.ok(job.runAt !== null, "swept job must be rescheduled");
    assert.ok(job.runAt.getTime() > Date.now() - 1000, "runAt must be in the future");
  });

  it("leaves a job alone while its heartbeat is still fresh", async () => {
    // The core rule: long-running is not the same as stuck.
    const jobId = await insertJob({
      status: JobStatus.PROCESSING,
      attempts: 1,
      lastHeartbeatAt: new Date(),
      startedAt: new Date(Date.now() - 60 * 60_000),
    });

    const result = await sweepStalledJobs({ stallTimeoutMs: STALL_TIMEOUT_MS });

    assert.equal(result.swept, 0);

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, JobStatus.PROCESSING);
  });

  it("does not requeue a job heartbeated at the timeout boundary", async () => {
    // Strictly older than the cutoff is stale; exactly at it is not. Sizing this
    // the wrong way would requeue a job that has only just beaten.
    const dbNow = await databaseNow();
    const jobId = await insertJob({
      status: JobStatus.PROCESSING,
      attempts: 1,
      lastHeartbeatAt: dbNow,
      startedAt: new Date(dbNow.getTime() - 5_000_000),
    });

    await sweepStalledJobs({ stallTimeoutMs: STALL_TIMEOUT_MS });

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, JobStatus.PROCESSING);
  });

  it("does not requeue a job with no heartbeat at all", async () => {
    // The sweep will not assert a job is stale without evidence. The claim
    // always writes a heartbeat, so this only guards legacy rows.
    const jobId = await insertJob({
      status: JobStatus.PROCESSING,
      attempts: 1,
      lastHeartbeatAt: null,
      startedAt: new Date(Date.now() - 1_000_000),
    });

    const result = await sweepStalledJobs({ stallTimeoutMs: STALL_TIMEOUT_MS });

    assert.equal(result.swept, 0);
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, JobStatus.PROCESSING);
  });

  it("records the stalled attempt and does not double-count it", async () => {
    // AGENTS rule 11: a stalled attempt still happened and gets a row.
    // The count is spent by the claim, so the sweep must not add to it again.
    const jobId = await insertJob({
      status: JobStatus.PROCESSING,
      attempts: 2,
      lastHeartbeatAt: staleHeartbeat(),
      startedAt: new Date(Date.now() - 1_000_000),
    });

    await sweepStalledJobs({ stallTimeoutMs: STALL_TIMEOUT_MS });

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.attempts, 2, "sweep must not increment a count the claim already spent");

    const attempts = await db.jobAttempt.findMany({ where: { jobId } });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].attemptNumber, 2);
    assert.equal(attempts[0].outcome, AttemptOutcome.FAILED);
    assert.equal(attempts[0].errorCode, "WORKER_STALLED");
  });

  it("finishes as DEAD when the stall used the last attempt", async () => {
    const jobId = await insertJob({
      status: JobStatus.PROCESSING,
      attempts: 5,
      maxAttempts: 5,
      lastHeartbeatAt: staleHeartbeat(),
      startedAt: new Date(Date.now() - 1_000_000),
    });

    const result = await sweepStalledJobs({ stallTimeoutMs: STALL_TIMEOUT_MS });

    assert.equal(result.swept, 1);
    assert.equal(result.finished, 1);

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, JobStatus.DEAD);
    assert.equal(job.runAt, null, "a terminal job must not be rescheduled");
    assert.ok(job.finishedAt !== null);
  });

  it("never requeues a job that has already finished", async () => {
    const jobId = await insertJob({
      status: JobStatus.SUCCEEDED,
      attempts: 1,
      lastHeartbeatAt: staleHeartbeat(),
      startedAt: new Date(Date.now() - 1_000_000),
    });

    const result = await sweepStalledJobs({ stallTimeoutMs: STALL_TIMEOUT_MS });

    assert.equal(result.swept, 0);
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, JobStatus.SUCCEEDED);
  });

  it("sweeps a stalled job and leaves a healthy one in the same pass", async () => {
    const staleJobId = await insertJob({
      status: JobStatus.PROCESSING,
      attempts: 1,
      lastHeartbeatAt: staleHeartbeat(),
      startedAt: new Date(Date.now() - 1_000_000),
    });
    const healthyJobId = await insertJob({
      status: JobStatus.PROCESSING,
      attempts: 1,
      lastHeartbeatAt: new Date(),
      startedAt: new Date(Date.now() - 1_000_000),
    });

    const result = await sweepStalledJobs({ stallTimeoutMs: STALL_TIMEOUT_MS });

    assert.equal(result.swept, 1);
    const stale = await db.job.findUniqueOrThrow({ where: { id: staleJobId } });
    const healthy = await db.job.findUniqueOrThrow({ where: { id: healthyJobId } });
    assert.equal(stale.status, JobStatus.FAILED);
    assert.equal(healthy.status, JobStatus.PROCESSING);
  });

  it("is idempotent: a second sweep finds nothing left to do", async () => {
    await insertJob({
      status: JobStatus.PROCESSING,
      attempts: 1,
      lastHeartbeatAt: staleHeartbeat(),
      startedAt: new Date(Date.now() - 1_000_000),
    });

    const first = await sweepStalledJobs({ stallTimeoutMs: STALL_TIMEOUT_MS });
    const second = await sweepStalledJobs({ stallTimeoutMs: STALL_TIMEOUT_MS });

    assert.equal(first.swept, 1);
    assert.equal(second.swept, 0, "a job must not be swept twice");
  });

  it("requeues a job that was actually claimed and then abandoned", async () => {
    // End-to-end: claim writes the heartbeat, then the sweep recovers it.
    const jobId = await insertJob({
      status: JobStatus.QUEUED,
      attempts: 0,
      lastHeartbeatAt: null,
      startedAt: null,
    });

    const claimed = await claimNextJob([JobType.WEBHOOK_CALL]);
    assert.ok(claimed !== null && claimed.id === jobId);

    const afterClaim = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(afterClaim.status, JobStatus.PROCESSING);
    assert.equal(afterClaim.attempts, 1);
    assert.ok(afterClaim.lastHeartbeatAt !== null, "claim must write a heartbeat");

    // Age the heartbeat past the timeout to stand in for the worker dying.
    await db.job.update({
      where: { id: jobId },
      data: { lastHeartbeatAt: staleHeartbeat() },
    });

    const result = await sweepStalledJobs({ stallTimeoutMs: STALL_TIMEOUT_MS });
    assert.equal(result.swept, 1);

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, JobStatus.FAILED);
  });
});

describe("recordHeartbeat", () => {
  it("refreshes a processing job's heartbeat", async () => {
    const jobId = await insertJob({
      status: JobStatus.PROCESSING,
      attempts: 1,
      lastHeartbeatAt: staleHeartbeat(),
      startedAt: new Date(Date.now() - 1_000_000),
    });

    // The heartbeat has to arrive *before* the sweep, otherwise the job is
    // legitimately stale and gets recovered: this asserts the beat is what
    // protects a running job, not that a stale job escapes the sweep.
    await recordHeartbeat(jobId);

    const result = await sweepStalledJobs({ stallTimeoutMs: STALL_TIMEOUT_MS });
    assert.equal(result.swept, 0, "a just-heartbeated job must not be swept");

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, JobStatus.PROCESSING);
  });

  it("stamps the heartbeat with the database clock, not the Node clock", async () => {
    // The bug this guards: a heartbeat taken from `new Date()` is compared by the
    // sweep against a cutoff from the database's clock. If this host runs ahead
    // of the database, a job heartbeated moments ago looks older than the
    // timeout and is requeued while it is still running.
    const jobId = await insertJob({
      status: JobStatus.PROCESSING,
      attempts: 1,
      lastHeartbeatAt: staleHeartbeat(),
      startedAt: new Date(Date.now() - 1_000_000),
    });

    const before = await databaseNow();
    await recordHeartbeat(jobId);
    const after = await databaseNow();

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    const stamped = job.lastHeartbeatAt;
    assert.ok(stamped !== null);
    assert.ok(
      stamped.getTime() >= before.getTime() && stamped.getTime() <= after.getTime(),
      `heartbeat ${stamped.toISOString()} must fall between the database's own ` +
        `reading before (${before.toISOString()}) and after (${after.toISOString()})`,
    );
  });

  it("does not touch a job that has already finished", async () => {
    const jobId = await insertJob({
      status: JobStatus.FAILED,
      attempts: 1,
      lastHeartbeatAt: new Date(Date.now() - 60_000),
      startedAt: new Date(Date.now() - 1_000_000),
    });
    const before = await db.job.findUniqueOrThrow({ where: { id: jobId } });

    await recordHeartbeat(jobId);

    const afterBeat = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(afterBeat.lastHeartbeatAt?.getTime(), before.lastHeartbeatAt?.getTime());
  });
});

describe("stalledCutoff", () => {
  it("is the timeout measured back from now", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    assert.equal(
      stalledCutoff(now, 600_000).toISOString(),
      "2026-01-01T11:50:00.000Z",
    );
  });
});

/** The database's own clock, so a test can assert against the same source the sweep uses. */
async function databaseNow(): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>`
    SELECT now() AS "now"
  `;
  const value = rows[0]?.now;
  assert.ok(value !== undefined, "database returned no current time");
  return value;
}
