import { Prisma } from "@prisma/client";
import type { JobType } from "@prisma/client";

import { db } from "../../lib/db/client";

/**
 * The row a worker owns after winning a claim. `attempts` has already been
 * incremented and `startedAt` set by the claim statement itself, so an executor
 * cannot misreport which attempt it is running.
 */
export type ClaimedJob = {
  id: string;
  accountId: string;
  type: JobType;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
  startedAt: Date;
};

/**
 * PR-QUEUE-001 / PR-QUEUE-003 / AGENTS rule 15.
 *
 * One statement does the whole claim: the inner SELECT picks a candidate with
 * `FOR UPDATE SKIP LOCKED`, and the outer UPDATE is conditioned on that exact
 * id. Two workers running this concurrently cannot both win, because the
 * second one either skips the locked row or finds the status already changed.
 * The database resolves the race, not an application-level check — the same
 * shape as the signup insert guarded by a unique constraint.
 *
 * `SKIP LOCKED` is not expressible in Prisma, which is why this is a
 * parameterized `$queryRaw` (AGENTS Q3, "no raw SQL except a parameterized
 * Prisma $queryRaw when a Prisma query genuinely cannot express the query").
 *
 * Two deliberate choices:
 *   - `FAILED` is claimable, not just `QUEUED`. Under the owner's Step 1 status
 *     model FAILED is a resting retry state, so excluding it would strand every
 *     retry. `SUCCEEDED` and `DEAD` are terminal (AGENTS rule 6) and can never
 *     appear here.
 *   - `runAt IS NULL OR runAt <= now()`, because a freshly created job has no
 *     runAt and must be claimable immediately.
 *   - `types` gates the claim on job types that actually have an executor, so a
 *     type with no implementation is left QUEUED rather than burned to DEAD by
 *     attempts it could never have made.
 *   - `lastHeartbeatAt` is set here, not by the executor. A claim with no
 *     heartbeat would be invisible to the stalled-job sweep, which matches on
 *     staleness (PR-RETRY-003), so the job would never be recovered.
 */
export async function claimNextJob(types: readonly JobType[]): Promise<ClaimedJob | null> {
  if (types.length === 0) {
    // No executor registered yet, so there is no type this worker may run.
    // Idling is deliberate: claiming anyway would burn attempts and drive jobs
    // to DEAD for work this build cannot do.
    return null;
  }

  const typeList = Prisma.join(
    types.map((type) => Prisma.sql`${type}::"JobType"`),
  );

  const claimed = await db.$queryRaw<ClaimedJob[]>`
    UPDATE "jobs"
    SET "status"         = 'PROCESSING'::"JobStatus",
        "startedAt"      = now(),
        "attempts"       = "attempts" + 1,
        "lastHeartbeatAt" = now(),
        "updatedAt"      = now()
    WHERE "id" = (
      SELECT "id"
      FROM "jobs"
      WHERE "status" IN ('QUEUED'::"JobStatus", 'FAILED'::"JobStatus")
        AND "type" IN (${typeList})
        AND ("runAt" IS NULL OR "runAt" <= now())
      ORDER BY "runAt" ASC NULLS FIRST, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING "id", "accountId", "type", "payload", "attempts", "maxAttempts", "startedAt"
  `;

  return claimed[0] ?? null;
}
