import { Prisma } from "@prisma/client";

import { db } from "../../lib/db/client";

/**
 * Owner's Step 5: an executor that produces an output must check whether the
 * output already exists before producing it, and the job id is the key.
 *
 * v1 keeps only a URL reference (PR-TECH-007 / PR-JOB-009), so "the output
 * exists" means "a reference to it has been recorded for this job". The
 * `(jobId)` unique constraint is the guard, in the same shape as the
 * idempotency-key insert: the database decides, not an application pre-check.
 */

export type JobOutput = {
  readonly jobId: string;
  readonly url: string;
};

function isJobOutputConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function findJobOutput(jobId: string): Promise<JobOutput | null> {
  return db.jobOutput.findUnique({ where: { jobId }, select: { jobId: true, url: true } });
}

/**
 * Records the reference, or returns the one that is already there.
 *
 * A P2002 is the expected signal that another run of the same job recorded its
 * output first; it is not an error, and the existing reference wins so both runs
 * agree on the same key.
 */
export async function recordJobOutput(input: {
  jobId: string;
  url: string;
}): Promise<{ readonly output: JobOutput; readonly created: boolean }> {
  try {
    const created = await db.jobOutput.create({
      data: { jobId: input.jobId, url: input.url },
      select: { jobId: true, url: true },
    });
    return { output: created, created: true };
  } catch (error) {
    if (!isJobOutputConflict(error)) {
      throw error;
    }
  }

  const existing = await findJobOutput(input.jobId);
  if (existing === null) {
    throw new Error(`Job ${input.jobId} reported an output conflict but has no output row`);
  }

  return { output: existing, created: false };
}

/**
 * The Step 5 contract for an executor that produces an artifact:
 *   1. look for an existing reference
 *   2. if one exists, return it WITHOUT producing again
 *   3. otherwise produce, then record the reference
 *
 * `produce` must derive its storage location from `jobId` (for example
 * `outputs/<jobId>.pdf`). That is what makes a repeat harmless at the storage
 * layer: overwriting the same key is idempotent, whereas a randomly named
 * object would leave a duplicate behind on every retry.
 *
 * Honest limitation: this guard makes the recorded output stable and unique, but
 * it cannot make `produce` run only once when a previous run died between
 * producing and recording. That case is handled by the deterministic key. Two
 * genuinely overlapping runs can both call `produce`; only one output row
 * survives, and both receive the same reference.
 */
export async function produceOutputOnce(args: {
  jobId: string;
  produce: () => Promise<string>;
}): Promise<{ readonly output: JobOutput; readonly produced: boolean }> {
  const existing = await findJobOutput(args.jobId);
  if (existing !== null) {
    return { output: existing, produced: false };
  }

  const url = await args.produce();
  const recorded = await recordJobOutput({ jobId: args.jobId, url });

  return { output: recorded.output, produced: recorded.created };
}
