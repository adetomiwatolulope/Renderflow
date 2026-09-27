import type { Prisma } from "@prisma/client";

import { db } from "../../lib/db/client";
import { JOB_RESPONSE_SELECT, type JobResponse } from "./dto";

/**
 * PR-JOB-004: `GET /v1/jobs/:id` returns the job's current status, its payload, its
 * result (on success) or last error (on failure), and its full attempt history.
 *
 * PR-OBS-003: the attempt history is exposed here programmatically, so the
 * dashboard is a view over this rather than a second data path.
 */

export const JOB_ATTEMPT_SELECT = {
  attemptNumber: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
  outcome: true,
  errorCode: true,
  errorMessage: true,
} satisfies Prisma.JobAttemptSelect;

export type JobAttemptSummary = Prisma.JobAttemptGetPayload<{
  select: typeof JOB_ATTEMPT_SELECT;
}>;

export type JobDetail = {
  readonly job: JobResponse;
  /**
   * Named `attemptHistory` rather than `attempts` on purpose: the job object
   * already carries `attempts` as a number (how many were used), and a sibling
   * `attempts` array would read as a contradiction of it.
   */
  readonly attemptHistory: readonly JobAttemptSummary[];
};

/**
 * PR-AUTH-004 / AGENTS rule 2: the account and the job id are matched in a
 * single query, so one account can never read another account's job even when it
 * knows or guesses the id. There is no unscoped variant of this function.
 *
 * The account check is part of the query rather than a lookup followed by a
 * comparison, so there is no window in which a job could be read before its
 * owner is known.
 *
 * Returns null for both "no such job" and "not yours". The caller must answer
 * both with the same 404: a 403 would confirm that the id exists, turning this
 * endpoint into a probe for other accounts' job ids.
 *
 * SEC-6: an explicit column allowlist, so a column added to the table later
 * cannot leak by default. Attempts are ordered by attempt number so the history
 * reads in the order the attempts actually happened.
 */
export async function getJobDetailForAccount(input: {
  accountId: string;
  jobId: string;
}): Promise<JobDetail | null> {
  const row = await db.job.findFirst({
    where: { id: input.jobId, accountId: input.accountId },
    select: {
      ...JOB_RESPONSE_SELECT,
      jobAttempts: {
        select: JOB_ATTEMPT_SELECT,
        orderBy: { attemptNumber: "asc" },
      },
    } satisfies Prisma.JobSelect,
  });

  if (row === null) {
    return null;
  }

  const { jobAttempts, ...job } = row;
  return { job, attemptHistory: jobAttempts };
}
