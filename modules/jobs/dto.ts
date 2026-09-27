import type { Prisma } from "@prisma/client";

/**
 * SEC-6: responses are built from an explicit allowlist rather than by
 * serializing a whole row, so a column added to the table later cannot leak by
 * default. `payload` is included because PR-JOB-004 returns it on the read
 * path, and the idempotency check needs the stored payload to compare against.
 */
export const JOB_RESPONSE_SELECT = {
  id: true,
  type: true,
  status: true,
  payload: true,
  attempts: true,
  maxAttempts: true,
  lastError: true,
  runAt: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  result: true,
} satisfies Prisma.JobSelect;

export type JobResponse = Prisma.JobGetPayload<{
  select: typeof JOB_RESPONSE_SELECT;
}>;
