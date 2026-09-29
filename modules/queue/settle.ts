import { AttemptOutcome, JobStatus, Prisma } from "@prisma/client";

import { db } from "../../lib/db/client";
import type { JsonObject } from "../jobs/json-value";
import { nextRunAt } from "../retry/backoff";
import type { ClaimedJob } from "./claim";

/**
 * Raised when a settle is attempted on a job that is no longer PROCESSING. The
 * guarded write below is what detects it; this surfaces the condition instead of
 * letting the transition look like it succeeded (CS-10).
 */
export class JobStateConflictError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was not in PROCESSING when the attempt was settled`);
    this.name = "JobStateConflictError";
  }
}

export type AttemptFailure = {
  /**
   * AGENTS rule 9 / PR-RETRY-002. Decided by the executor for this specific
   * attempt, never inferred from an HTTP status. A non-retryable failure is
   * finished immediately as DEAD rather than resting until its attempts run out.
   */
  readonly retryable: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
};

function elapsedMsSince(startedAt: Date, now: Date): number {
  return Math.max(0, now.getTime() - startedAt.getTime());
}

/**
 * Every transition is an explicit function (CS-13), and every write is
 * conditioned on the current status (CS-7) rather than read-then-write.
 *
 * AGENTS rule 6: neither function can move a job out of SUCCEEDED or DEAD,
 * because both require status PROCESSING. There is no other path that writes
 * status, so a terminal job is terminal.
 */
export async function markJobSucceeded(
  job: ClaimedJob,
  result: JsonObject | null,
): Promise<void> {
  const now = new Date();

  await db.$transaction(async (tx) => {
    const updated = await tx.job.updateMany({
      where: { id: job.id, status: JobStatus.PROCESSING },
      data: {
        status: JobStatus.SUCCEEDED,
        finishedAt: now,
        result: result ?? Prisma.DbNull,
        lastError: null,
      },
    });

    if (updated.count !== 1) {
      throw new JobStateConflictError(job.id);
    }

    // AGENTS rule 11: every attempt gets its own row and a prior attempt's row
    // is never overwritten.
    await tx.jobAttempt.create({
      data: {
        jobId: job.id,
        attemptNumber: job.attempts,
        startedAt: job.startedAt,
        finishedAt: now,
        durationMs: elapsedMsSince(job.startedAt, now),
        outcome: AttemptOutcome.SUCCEEDED,
      },
    });
  });
}

/**
 * A failed attempt rests in FAILED until its backoff elapses. It is finished as
 * DEAD instead when the attempt was non-retryable, or when it was the last
 * permitted attempt.
 *
 * `job.attempts` was already incremented by the claim, so it is the number of
 * the attempt that just failed and is compared against the fixed maxAttempts
 * (PR-RETRY-001). A finished job gets no runAt, so it is never re-claimable.
 *
 * `options.heartbeatStaleBefore` makes the write conditional on the heartbeat
 * still being stale at that instant. The stalled-job sweep needs this: a job is
 * found by reading, but a heartbeat can land between that read and this write,
 * and a worker that is merely slow must not be requeued (AGENTS rule 10).
 * Expressing it as part of the write keeps the check and the transition atomic
 * (CS-7). A count of 0 then means the heartbeat arrived in time.
 *
 * Throws JobStateConflictError when the guarded write matched no row, which for
 * the worker path means the job is no longer PROCESSING.
 */
export async function settleAttemptFailure(
  job: ClaimedJob,
  failure: AttemptFailure,
  options: { readonly heartbeatStaleBefore?: Date } = {},
): Promise<JobStatus> {
  const now = new Date();
  const isExhausted = !failure.retryable || job.attempts >= job.maxAttempts;
  const nextStatus = isExhausted ? JobStatus.DEAD : JobStatus.FAILED;

  const guard: Prisma.JobWhereInput = {
    id: job.id,
    status: JobStatus.PROCESSING,
    ...(options.heartbeatStaleBefore === undefined
      ? {}
      : { lastHeartbeatAt: { lt: options.heartbeatStaleBefore } }),
  };

  await db.$transaction(async (tx) => {
    const updated = await tx.job.updateMany({
      where: guard,
      data: {
        status: nextStatus,
        lastError: failure.errorMessage,
        finishedAt: isExhausted ? now : null,
        runAt: isExhausted ? null : nextRunAt(now, job.attempts),
      },
    });

    if (updated.count !== 1) {
      throw new JobStateConflictError(job.id);
    }

    await tx.jobAttempt.create({
      data: {
        jobId: job.id,
        attemptNumber: job.attempts,
        startedAt: job.startedAt,
        finishedAt: now,
        durationMs: elapsedMsSince(job.startedAt, now),
        outcome: AttemptOutcome.FAILED,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
      },
    });
  });

  return nextStatus;
}
