import { JobStatus } from "@prisma/client";

import { db } from "../../lib/db/client";
import type { ClaimedJob } from "./claim";
import { JobStateConflictError, settleAttemptFailure } from "./settle";

/**
 * Owner's Step 6: recover jobs whose worker died mid-job, instead of leaving a
 * row in PROCESSING forever.
 *
 * PR-RETRY-003 / AGENTS rule 10: "stuck" means the heartbeat has stopped, not
 * that the job has been processing for a long time. A job that is still ticking
 * its heartbeat is a slow but healthy job and is left completely alone.
 *
 * Requeueing goes through the same settle path as any other failed attempt, so a
 * stalled attempt gets its own JobAttempt row (AGENTS rule 11), is scheduled with
 * the same jittered backoff, and is finished as DEAD if it was the last permitted
 * attempt rather than being requeued forever.
 */

const STALLED_ERROR_CODE = "WORKER_STALLED";
const STALLED_ERROR_MESSAGE =
  "Worker heartbeat stopped before the job settled; the attempt is being retried";

/** Most jobs recovered in one sweep. A larger backlog is spread over later sweeps. */
const SWEEP_BATCH_SIZE = 100;

export type SweepResult = {
  /** Jobs moved out of PROCESSING by this sweep. */
  readonly swept: number;
  /** Of those, how many were finished as DEAD rather than rescheduled. */
  readonly finished: number;
  /** Skipped because a heartbeat arrived, or another sweep got there first. */
  readonly skipped: number;
};

export function stalledCutoff(now: Date, stallTimeoutMs: number): Date {
  return new Date(now.getTime() - stallTimeoutMs);
}

/**
 * Reads the database clock. Every staleness comparison has to happen in one
 * clock domain: the claim and the heartbeat both stamp `now()` in SQL, so the
 * cutoff must come from the same source. Taking it from `new Date()` would make
 * a swept job's fate depend on how far this host's clock has drifted from the
 * database's.
 */
async function databaseNow(): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>`
    SELECT now() AS "now"
  `;
  const value = rows[0]?.now;
  if (value === undefined) {
    throw new Error("Database returned no current time");
  }
  return value;
}

export async function sweepStalledJobs(options: { stallTimeoutMs: number }): Promise<SweepResult> {
  const cutoff = stalledCutoff(await databaseNow(), options.stallTimeoutMs);

  // A NULL lastHeartbeatAt is deliberately not matched. The claim always sets
  // one, so a NULL cannot be produced by this codebase, and a row the sweep
  // cannot prove to be stale is left alone rather than risk a double execution.
  //
  // Bounded so a large backlog of casualties is recovered over successive
  // sweeps instead of loading every stale row at once.
  const stalled = await db.job.findMany({
    where: {
      status: JobStatus.PROCESSING,
      lastHeartbeatAt: { lt: cutoff },
    },
    orderBy: { lastHeartbeatAt: "asc" },
    take: SWEEP_BATCH_SIZE,
    select: {
      id: true,
      accountId: true,
      type: true,
      payload: true,
      attempts: true,
      maxAttempts: true,
      startedAt: true,
    },
  });

  let swept = 0;
  let finished = 0;
  let skipped = 0;

  for (const row of stalled) {
    // startedAt is set by the claim, so it is present on any PROCESSING row; the
    // fallback only stops a null from crashing the sweep.
    const job: ClaimedJob = { ...row, startedAt: row.startedAt ?? cutoff };

    try {
      const status = await settleAttemptFailure(
        job,
        {
          // Retryable: a stall is a worker failure, not a verdict on the work.
          // The attempt count is already spent, so a job that keeps stalling
          // still reaches DEAD instead of looping.
          retryable: true,
          errorCode: STALLED_ERROR_CODE,
          errorMessage: STALLED_ERROR_MESSAGE,
        },
        { heartbeatStaleBefore: cutoff },
      );

      swept += 1;
      if (status === JobStatus.DEAD) {
        finished += 1;
      }
    } catch (error) {
      // The guarded write matched nothing, which means a heartbeat landed
      // between the read and the write, or another sweep already handled it.
      // Either way the job is fine and must not be reported as swept.
      if (error instanceof JobStateConflictError) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }

  return { swept, finished, skipped };
}

/**
 * Runs the sweep on an interval for the life of the process. A sweep that throws
 * is logged and the schedule continues, because a transient database error must
 * not permanently stop stalled jobs being recovered.
 */
export function startStalledJobSweep(intervalMs: number, stallTimeoutMs: number): () => void {
  const runOnce = async (): Promise<void> => {
    try {
      const result = await sweepStalledJobs({ stallTimeoutMs });
      if (result.swept > 0 || result.skipped > 0) {
        console.log(
          `Stalled-job sweep: swept ${result.swept}, finished ${result.finished}, ` +
            `skipped ${result.skipped}`,
        );
      }
    } catch (error) {
      console.error("Stalled-job sweep failed", error);
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);

  timer.unref();

  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}
