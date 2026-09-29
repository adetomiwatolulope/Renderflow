import { Prisma } from "@prisma/client";

import { db } from "../../lib/db/client";
import { assertWithinSubmissionCaps } from "../abuse/enforce-submission-caps";
import { maxAttemptsForType } from "../retry/config";
import { payloadsAreDeepEqual } from "./canonical-json";
import { JOB_RESPONSE_SELECT, type JobResponse } from "./dto";
import { IdempotencyConflictError } from "./errors";
import { validateJobSubmission } from "./validate-create-job";

export type CreateJobResult =
  | { readonly outcome: "created"; readonly job: JobResponse }
  | { readonly outcome: "existing"; readonly job: JobResponse };

function isIdempotencyKeyConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function findJobByIdempotencyKey(
  accountId: string,
  idempotencyKey: string,
): Promise<JobResponse | null> {
  return db.job.findUnique({
    where: { accountId_idempotencyKey: { accountId, idempotencyKey } },
    select: JOB_RESPONSE_SELECT,
  });
}

/**
 * The one module function behind `POST /v1/jobs` (CS-11).
 *
 * PR-JOB-002: a created job is QUEUED, which is also immediately claimable
 * because `runAt` is left NULL (PR-QUEUE-002).
 *
 * PR-TECH-004 / CS-4: the `(accountId, idempotencyKey)` unique constraint does
 * the enforcement, not an application-level pre-check, so two simultaneous
 * submissions with the same key cannot both insert. A P2002 is the expected
 * rejection signal for a duplicate, never a 500. The payload comparison happens
 * afterwards, in application code, once the constraint has established which
 * row is authoritative (PR-IDEM-002).
 */
export async function createJob(input: {
  accountId: string;
  body: unknown;
}): Promise<CreateJobResult> {
  const submission = validateJobSubmission(input.body);

  // A replay is not a new submission, so the abuse caps do not apply to it.
  //
  // PR-IDEM-002 and PR-ABUSE-001 collide here: a caller whose key matches an
  // existing job must get that job back, but the caps must also be unbypassable.
  // The reading that satisfies both is that the caps bound job *creation*, and a
  // replay creates nothing. Checking the key first means a client that retries
  // after a timeout is never locked out by its own retry, while a genuinely new
  // key is still checked below. The unique constraint remains the real
  // enforcement of PR-IDEM-002; this only avoids refusing a replay the PRD says
  // must succeed.
  const replay = await findJobByIdempotencyKey(
    input.accountId,
    submission.idempotencyKey,
  );
  if (replay !== null) {
    if (!payloadsAreDeepEqual(replay.payload, submission.payload)) {
      throw new IdempotencyConflictError();
    }
    return { outcome: "existing", job: replay };
  }

  try {
    const created = await db.$transaction(async (tx) => {
      await assertWithinSubmissionCaps(tx, input.accountId);
      const job = await tx.job.create({
        data: {
          accountId: input.accountId,
          type: submission.type,
          payload: submission.payload,
          idempotencyKey: submission.idempotencyKey,
          // CS-7 / SEC-5: status, attempts, maxAttempts and lastError are server
          // decisions. Only the fields the caller is allowed to set are named.
          maxAttempts: maxAttemptsForType(submission.type),
        },
        select: JOB_RESPONSE_SELECT,
      });
      return job;
    });

    return { outcome: "created", job: created };
  } catch (error) {
    if (!isIdempotencyKeyConflict(error)) {
      throw error;
    }
  }

  const existing = await findJobByIdempotencyKey(
    input.accountId,
    submission.idempotencyKey,
  );

  if (existing === null) {
    // The constraint reported a conflict but the row is not readable. Treat it
    // as a conflict rather than inventing a job to return.
    throw new IdempotencyConflictError();
  }

  if (!payloadsAreDeepEqual(existing.payload, submission.payload)) {
    throw new IdempotencyConflictError();
  }

  return { outcome: "existing", job: existing };
}
