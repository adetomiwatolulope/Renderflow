-- Every timestamp becomes `timestamptz` (absolute instant).
--
-- Why: the columns were naive `timestamp(3)`, but the queue compares values
-- written by the database's `now()` (a `timestamptz`) against a cutoff computed
-- from the same `now()`. Postgres casts a `timestamptz` into a naive column using
-- the *session* timezone, and Prisma reads a naive value back as UTC. On a
-- database whose session timezone is not UTC, the two sides of that comparison
-- land in different clock domains, separated by exactly the session's UTC offset.
--
-- The failure is not cosmetic. A stale PROCESSING job is recovered only when its
-- heartbeat falls behind the cutoff, so with the offset applied:
--   - session timezone ahead of UTC  -> stored heartbeats look fresh for an extra
--     `offset` (an hour here), so a dead worker's job sits unrecovered that long.
--   - session timezone behind UTC   -> a job heartbeated seconds ago looks older
--     than the stall timeout, so the sweep requeues a job that is still running.
--     That is a double execution: duplicate emails, duplicate caller webhooks
--     (AGENTS rule 10 / PR-RETRY-003).
--
-- `timestamptz` makes the stored value absolute, so the sweep's cutoff and the
-- heartbeat it compares against are the same instant regardless of where the
-- database host or the worker is configured.
--
-- Existing rows are converted with `AT TIME ZONE 'UTC'`, which is the reading
-- Prisma was already giving these naive columns, so no value shifts on the way
-- out. The only rows in this table at the time of writing were test fixtures
-- created by the integration suite, so there is no production history whose
-- original timezone would need preserving.

ALTER TABLE "accounts"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "api_keys"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "rotatedAt"  TYPE timestamptz(3) USING "rotatedAt"  AT TIME ZONE 'UTC';

ALTER TABLE "jobs"
  ALTER COLUMN "runAt"           TYPE timestamptz(3) USING "runAt"           AT TIME ZONE 'UTC',
  ALTER COLUMN "startedAt"       TYPE timestamptz(3) USING "startedAt"       AT TIME ZONE 'UTC',
  ALTER COLUMN "lastHeartbeatAt" TYPE timestamptz(3) USING "lastHeartbeatAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt"       TYPE timestamptz(3) USING "createdAt"       AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt"       TYPE timestamptz(3) USING "updatedAt"       AT TIME ZONE 'UTC',
  ALTER COLUMN "finishedAt"      TYPE timestamptz(3) USING "finishedAt"      AT TIME ZONE 'UTC';

ALTER TABLE "job_attempts"
  ALTER COLUMN "startedAt"  TYPE timestamptz(3) USING "startedAt"  AT TIME ZONE 'UTC',
  ALTER COLUMN "finishedAt" TYPE timestamptz(3) USING "finishedAt" AT TIME ZONE 'UTC';

ALTER TABLE "job_outputs"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "webhook_endpoints"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "webhook_deliveries"
  ALTER COLUMN "sentAt"    TYPE timestamptz(3) USING "sentAt"    AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC';
