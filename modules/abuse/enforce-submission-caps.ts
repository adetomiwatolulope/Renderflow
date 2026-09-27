import { JobStatus, type Prisma } from "@prisma/client";

import { db } from "../../lib/db/client";

/**
 * PR-ABUSE-001: per-account cost and abuse control, independent of any billing
 * plan (there is none in v1). Two caps:
 *
 *   - concurrent non-terminal jobs (QUEUED + PROCESSING), default 100
 *   - job submissions in the current UTC day, default 5,000
 *
 * Either one returns 429 on a new submission. The reason both exist is
 * unbounded submission volume: an AI_REQUEST job in particular can carry real
 * third-party cost, and with no billing gate in v1 the caps are the only thing
 * standing between a caller and an unbounded bill.
 */

const DEFAULT_CONCURRENT_CAP = 100;
const DEFAULT_DAILY_CAP = 5_000;

const NON_TERMINAL: readonly JobStatus[] = [JobStatus.QUEUED, JobStatus.PROCESSING];

function readPositiveIntegerEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return parsed;
}

export function concurrentCap(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntegerEnv("CONCURRENT_NON_TERMINAL_CAP", DEFAULT_CONCURRENT_CAP, env);
}

export function dailySubmissionCap(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntegerEnv("DAILY_SUBMISSION_CAP", DEFAULT_DAILY_CAP, env);
}

/** Which cap refused the submission, so the route can say which one. */
export type SubmissionCapKind = "concurrent" | "daily";

/** Thrown by assertWithinSubmissionCaps; the route turns this into a 429. */
export class SubmissionCapExceededError extends Error {
  readonly kind: SubmissionCapKind;
  readonly limit: number;

  constructor(kind: SubmissionCapKind, limit: number) {
    super(
      kind === "concurrent"
        ? `Concurrent non-terminal job cap of ${limit} reached`
        : `Daily submission cap of ${limit} reached`,
    );
    this.name = "SubmissionCapExceededError";
    this.kind = kind;
    this.limit = limit;
  }
}

/** The smallest transaction both the caps check and the insert can share. */
export type CapCheckClient = Pick<Prisma.TransactionClient, "job" | "$queryRaw">;

/**
 * Refuses the submission when either cap is already reached.
 *
 * CS-7 requires the check to be part of the write rather than a `count` followed
 * by a separate insert, because two submissions arriving together would both
 * read 99 and both insert, leaving 101. Taking a row lock on the account first
 * serialises every submission for that account, so the counts cannot move under
 * the check. The lock is held only for the length of the caller's transaction.
 *
 * The counts are exact rather than estimated, which is why no counter columns are
 * maintained on Account: a counter would have to be decremented on every terminal
 * transition, and any path that missed one would permanently leak capacity.
 */
export async function assertWithinSubmissionCaps(
  client: CapCheckClient,
  accountId: string,
  options: { readonly concurrent?: number; readonly daily?: number } = {},
): Promise<void> {
  const maxConcurrent = options.concurrent ?? concurrentCap();
  const maxDaily = options.daily ?? dailySubmissionCap();

  // Serialises concurrent submissions for this account. The value is unused; the
  // lock is the point.
  await client.$queryRaw`SELECT id FROM "accounts" WHERE id = ${accountId} FOR UPDATE`;

  const [nonTerminal, submittedToday] = await Promise.all([
    client.job.count({ where: { accountId, status: { in: [...NON_TERMINAL] } } }),
    client.job.count({
      where: { accountId, createdAt: { gte: startOfUtcDay(new Date()) } },
    }),
  ]);

  if (nonTerminal >= maxConcurrent) {
    throw new SubmissionCapExceededError("concurrent", maxConcurrent);
  }
  if (submittedToday >= maxDaily) {
    throw new SubmissionCapExceededError("daily", maxDaily);
  }
}

function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
}

/**
 * Caps are enforced against the queue, not against a stored counter, so the only
 * state this needs is the job table itself. Exposed for the route's tests and for
 * any future reconciliation.
 */
export async function currentUsage(accountId: string): Promise<{
  nonTerminal: number;
  submittedToday: number;
}> {
  const [nonTerminal, submittedToday] = await Promise.all([
    db.job.count({ where: { accountId, status: { in: [...NON_TERMINAL] } } }),
    db.job.count({ where: { accountId, createdAt: { gte: startOfUtcDay(new Date()) } } }),
  ]);
  return { nonTerminal, submittedToday };
}
