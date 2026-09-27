import { JobStatus, JobType, type Prisma } from "@prisma/client";

import { db } from "../../lib/db/client";
import { JOB_RESPONSE_SELECT, type JobResponse } from "./dto";

/**
 * PR-JOB-005: `GET /v1/jobs` lists the caller's own jobs newest-first, optionally
 * filtered by status or type, with opaque cursor pagination.
 *
 * The accountId comes from the resolved API key and is part of the where clause,
 * not a parameter a caller can influence. PR-AUTH-004 holds here exactly as it
 * does on the single-job read: listing never widens the scope to other accounts,
 * and the cursor is not a job reference that could reach one.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export class InvalidJobListQueryError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`Invalid ${field}: ${detail}`);
    this.name = "InvalidJobListQueryError";
    this.field = field;
  }
}

export type JobListQuery = {
  readonly status?: string;
  readonly type?: string;
  readonly cursor?: string;
  readonly limit?: string;
};

export type JobPage = {
  readonly jobs: readonly JobResponse[];
  readonly nextCursor: string | null;
};

/**
 * Opaque and self-describing enough to debug, but deliberately not a raw offset:
 * an offset shifts when a concurrent insert lands, so a caller paging through a
 * busy queue would silently skip or repeat rows. `(createdAt, id)` is stable
 * because job ids are unique, so the tie-break makes the ordering total.
 */
type Cursor = { readonly createdAt: Date; readonly id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new InvalidJobListQueryError("cursor", "not a cursor issued by this endpoint");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { createdAt?: unknown }).createdAt !== "string" ||
    typeof (parsed as { id?: unknown }).id !== "string"
  ) {
    throw new InvalidJobListQueryError("cursor", "not a cursor issued by this endpoint");
  }

  const createdAt = new Date((parsed as { createdAt: string }).createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new InvalidJobListQueryError("cursor", "carries an unparseable timestamp");
  }

  return { createdAt, id: (parsed as { id: string }).id };
}

function parseEnumFilter<T extends string>(
  field: "status" | "type",
  raw: string,
  allowed: readonly T[],
): T {
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new InvalidJobListQueryError(field, `must be one of ${allowed.join(", ")}`);
  }
  return raw as T;
}

function parsePageSize(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new InvalidJobListQueryError("limit", `must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  return parsed;
}

function buildWhere(accountId: string, query: JobListQuery): Prisma.JobWhereInput {
  const where: Prisma.JobWhereInput = { accountId };

  if (query.status !== undefined) {
    where.status = parseEnumFilter("status", query.status, Object.values(JobStatus));
  }
  if (query.type !== undefined) {
    where.type = parseEnumFilter("type", query.type, Object.values(JobType));
  }
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor);
    // Strictly "older than the last row of the previous page", with the id
    // tie-break, so a page boundary never repeats or skips a row.
    where.OR = [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ];
  }

  return where;
}

export async function listJobsForAccount(
  accountId: string,
  query: JobListQuery = {},
): Promise<JobPage> {
  const pageSize = parsePageSize(query.limit);
  const where = buildWhere(accountId, query);

  // One extra row answers "is there another page" without a second count query.
  const rows = await db.job.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: pageSize + 1,
    select: JOB_RESPONSE_SELECT,
  });

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page.at(-1);

  return {
    jobs: page,
    nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
  };
}
