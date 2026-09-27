import { db } from "../db/client";

/**
 * PR-TECH-006: 100 requests per minute per API key, 429 on excess, counted in
 * Postgres rather than in process memory so the limit survives more than one web
 * instance.
 *
 * The window slides. A plain fixed window lets a caller spend the whole budget at
 * 0.9s and again at 60.1s, which is 200 requests in a 1.2s burst. This keeps two
 * minute buckets per key and weights the older one by how much of it still falls
 * inside the trailing 60 seconds:
 *
 *     estimated requests in the last 60s = current + previous * (1 - progress)
 *
 * where `progress` is the fraction of the current minute already elapsed. The
 * estimate is never below the true count, so the limiter can over-reject at a
 * boundary but never lets a caller through.
 *
 * Every timestamp is the database's clock. `now()` rather than a JavaScript Date,
 * for the same reason the heartbeat is: the bucket boundary and the arithmetic
 * have to be in one clock domain or a skewed host silently grants or denies.
 */

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 100;

const WINDOW_MS = 60_000;

/** Read by readPositiveInteger at the route boundary; kept here as the default. */
export function rateLimitPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RATE_LIMIT_PER_MINUTE;
  if (raw === undefined) {
    return DEFAULT_RATE_LIMIT_PER_MINUTE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`RATE_LIMIT_PER_MINUTE must be a positive integer, got ${raw}`);
  }
  return parsed;
}

export type RateLimitDecision = {
  readonly allowed: boolean;
  readonly limit: number;
  readonly estimatedCount: number;
  /** Seconds until the trailing window can free capacity. Always >= 1 when refused. */
  readonly retryAfterSeconds: number;
};

/**
 * Consumes one unit of the caller's budget and reports whether it was available.
 *
 * The increment is the write, and it is an upsert so concurrent requests against
 * the same key serialise on the primary key instead of losing counts. A refused
 * request still increments: it was a real request and must count against the next
 * window, otherwise a caller could keep hammering past the limit for free.
 */
export async function consumeRateLimit(
  key: string,
  limit: number = rateLimitPerMinute(),
): Promise<RateLimitDecision> {
  const rows = await db.$queryRaw<Array<{ current: number; previous: number; progress: number }>>`
    WITH bucket AS (
      SELECT date_trunc('minute', now()) AS start
    ),
    incremented AS (
      INSERT INTO "rate_limit_windows" ("key", "windowStart", "count", "updatedAt")
      SELECT ${key}, start, 1, now() FROM bucket
      ON CONFLICT ("key", "windowStart")
      DO UPDATE SET "count" = "rate_limit_windows"."count" + 1, "updatedAt" = now()
      RETURNING "count" AS current
    ),
    previous_bucket AS (
      SELECT COALESCE((
        SELECT "count" FROM "rate_limit_windows"
        WHERE "key" = ${key}
          AND "windowStart" = (SELECT start FROM bucket) - INTERVAL '1 minute'
      ), 0) AS previous
    ),
    clock AS (
      SELECT
        EXTRACT(SECOND FROM now() - date_trunc('minute', now()))::float8 / 60.0 AS progress
      FROM bucket
    )
    SELECT
      incremented.current,
      previous_bucket.previous,
      LEAST(clock.progress, 0.999999) AS progress
    FROM incremented, previous_bucket, clock
  `;

  const row = rows[0];
  if (row === undefined) {
    // The upsert always returns a row; treat its absence as a server fault
    // rather than silently allowing an unlimited request.
    throw new Error("Rate limit accounting returned no row");
  }

  const estimatedCount = Math.ceil(row.current + row.previous * (1 - row.progress));
  const allowed = estimatedCount <= limit;

  return {
    allowed,
    limit,
    estimatedCount,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((estimatedCount - limit) * (WINDOW_MS / 1000) / Math.max(1, row.current))),
  };
}

/**
 * Buckets older than the previous one can never influence a decision, so they
 * are only kept to make the read cheap. Intended for a periodic job, not the
 * request path.
 */
export async function discardStaleRateLimitWindows(): Promise<number> {
  const deleted = await db.$executeRaw`
    DELETE FROM "rate_limit_windows"
    WHERE "windowStart" < date_trunc('minute', now()) - INTERVAL '1 minute'
  `;
  return deleted;
}
