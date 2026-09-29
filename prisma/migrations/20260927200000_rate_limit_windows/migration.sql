-- PR-TECH-006: the Postgres-backed rate-limit counter.
--
-- Deliberately not an in-memory counter (AGENTS "Rate limiting"): the limit must
-- hold if the web app ever runs as more than one instance. The PRD accepts the
-- one-write-per-request cost of that guarantee and names Redis for rate limiting
-- only as a flagged v2 decision, never a default fallback.
--
-- One row per (key, minute bucket). The limiter reads the current and previous
-- bucket and weights the previous by how far into the current minute it is, so
-- the window slides instead of resetting on the minute boundary.

CREATE TABLE "rate_limit_windows" (
    "key"         TEXT                     NOT NULL,
    "windowStart" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
    "count"       INTEGER                  NOT NULL DEFAULT 0,
    "updatedAt"   TIMESTAMP(3) WITH TIME ZONE NOT NULL,

    CONSTRAINT "rate_limit_windows_pkey" PRIMARY KEY ("key", "windowStart")
);

-- Supports discarding buckets that can no longer influence a decision.
CREATE INDEX "rate_limit_windows_windowStart_idx" ON "rate_limit_windows" ("windowStart");
