import { JobStatus, type JobType, type Prisma } from "@prisma/client";

import { db } from "../../lib/db/client";
import type { JsonValue } from "./json-value";

/**
 * The operator's view of jobs that need a human.
 *
 * Scope: this is READ ONLY. It lists and explains, and it deliberately offers no
 * way to change a job's state.
 *
 * Manual replay of a dead job is out of scope for v1. The PRD scopes v1 to
 * "a FAILED job is queryable but not re-submittable through a dedicated UI"
 * (Section 1), lists "dead-letter replay tooling" as explicitly out of scope for
 * v1 and as a v2 candidate (Section 13), and leaves Open Question 4 — whether a
 * DLQ with manual replay should exist at all — undecided. The owner chose the
 * read-only half for this build; the retry affordance is deferred, not forgotten.
 * A future replay action must move the existing Job row (AGENTS rule 14) and must
 * not create a second job.
 */

/** Most dead jobs returned in one read. A larger backlog is reported, not hidden. */
export const DEAD_JOB_PAGE_SIZE = 100;

const DEAD_JOB_SELECT = {
  id: true,
  type: true,
  payload: true,
  lastError: true,
  attempts: true,
  maxAttempts: true,
  createdAt: true,
  finishedAt: true,
} satisfies Prisma.JobSelect;

export type DeadJobSummary = {
  readonly id: string;
  readonly type: JobType;
  readonly payload: JsonValue;
  readonly lastError: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly finishedAt: string | null;
};

export type DeadLetterListing = {
  readonly jobs: readonly DeadJobSummary[];
  /** Every dead job this account has, which may exceed `jobs.length`. */
  readonly totalDead: number;
  readonly pageSize: number;
};

/**
 * PR-AUTH-004: scoped to one account by the id resolved from the presented API
 * key, so this can never surface another account's jobs even for a known job id.
 * There is no cross-account variant of this function by design.
 *
 * SEC-6: built from an explicit column allowlist, so a column added to the table
 * later cannot leak into this view by default.
 */
export async function listDeadJobsForAccount(accountId: string): Promise<DeadLetterListing> {
  const where: Prisma.JobWhereInput = { accountId, status: JobStatus.DEAD };

  // One transaction so the count and the page describe the same snapshot; a
  // concurrent settle would otherwise make the view claim to show more rows than
  // it lists.
  const [rows, totalDead] = await db.$transaction([
    db.job.findMany({
      where,
      orderBy: [{ finishedAt: "desc" }, { createdAt: "desc" }],
      take: DEAD_JOB_PAGE_SIZE,
      select: DEAD_JOB_SELECT,
    }),
    db.job.count({ where }),
  ]);

  const jobs = rows.map((row) => ({
    id: row.id,
    type: row.type,
    payload: row.payload as JsonValue,
    lastError: row.lastError,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));

  return { jobs, totalDead, pageSize: DEAD_JOB_PAGE_SIZE };
}
