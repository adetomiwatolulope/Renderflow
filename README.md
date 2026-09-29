# RenderFlow

A background job processing platform. Callers submit jobs over an HTTP API instead
of running that work inside their own request path; RenderFlow queues each job,
executes it in a standalone worker process, retries recoverable failures under a
fixed backoff policy, and notifies the caller by webhook when the job reaches a
final state.

- **Source of truth:** `docx/RenderFlow_PRD_v2.md` (v2, post-review).
- **Build rules:** `AGENTS.md` — read it before changing anything. It defines what
  is locked, what must never happen, and how work is placed.
- **Verification log:** `evidence/`.

## Stack (locked)

| | |
|---|---|
| App | Next.js App Router, TypeScript strict, no `any` |
| Database | PostgreSQL via Prisma (no raw SQL except parameterized `$queryRaw`) |
| Queue | PostgreSQL. `SELECT ... FOR UPDATE SKIP LOCKED`. No Redis, no external queue. |
| Worker | One standalone long-running Node process, separate from the web app |
| Rate limit | Postgres-backed rolling window. Never in-memory. |

No billing exists in v1 — there is no `modules/billing`, no payment provider
integration, and no amount field anywhere in the schema.

## Getting started

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL
npm run db:migrate          # prisma migrate deploy
npm run seed-demo           # optional: a spread of jobs in every status
```

Run the two processes separately — the API and the worker are different
deployables and the worker is not started by the web app:

```bash
npm run dev                 # web app on http://localhost:3001
npm run worker              # worker: claim → execute → settle, polling every 1s
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — | Required. PostgreSQL connection string. |
| `WORKER_CONCURRENCY` | `10` | Max jobs this worker process runs at once (per-process, not system-wide) |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Wait after finding nothing claimable |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `30000` | Heartbeat refresh interval while a job is processing |
| `WORKER_STALL_TIMEOUT_MS` | `600000` | A job is stalled only once its heartbeat is this stale |
| `WORKER_SWEEP_INTERVAL_MS` | `60000` | How often the stalled-job sweep runs |
| `RATE_LIMIT_PER_MINUTE` | `100` | Per-account API request limit |
| `CONCURRENT_NON_TERMINAL_CAP` | `100` | Per-account concurrent QUEUED + PROCESSING jobs |
| `DAILY_SUBMISSION_CAP` | `5000` | Per-account job submissions per UTC day |

Retry configuration is deliberately **not** in this table and **not** in the
database: `maxAttempts` and backoff timing are fixed in application code
(`modules/retry/config.ts`, `modules/retry/backoff.ts`) with no API surface to
change them.

### Scripts

| Command | Does |
|---|---|
| `npm run dev` | Web app on port 3001 |
| `npm run worker` | The standalone worker process |
| `npm run build` / `npm run start` | Production web app |
| `npm run typecheck` | `tsc --noEmit`, zero errors expected |
| `npm run lint` | ESLint |
| `npm test` | Unit tests |
| `npm run test:integration` | Integration tests (needs a real `DATABASE_URL`; `--test-concurrency=1`) |
| `npm run db:migrate` | Apply migrations |
| `npm run seed-demo` | Insert demo jobs across all statuses |
| `npm run provision-account` | Create an account and print its API key once |

## The job record

Every job is one row. The schema is the source of truth — this section explains
it, it does not replace it. See `prisma/schema.prisma` (`model Job`, line 80).

| Field | Type | What it is |
|---|---|---|
| `id` | `String` `@default(cuid())` | Generated, opaque job id |
| `accountId` | `String` | Owning account; every read and write is scoped to it |
| `type` | `JobType` | What kind of work this is: `PDF_GENERATION`, `IMAGE_PROCESSING`, `EMAIL_DELIVERY`, `AI_REQUEST`, `WEBHOOK_CALL`, `CUSTOM` |
| `payload` | `Json` | The input. Rejected above 256KB before the row is created |
| `status` | `JobStatus` | `QUEUED` \| `PROCESSING` \| `SUCCEEDED` \| `FAILED` \| `DEAD` |
| `attempts` | `Int` | How many times it has run. Incremented by the claim, not by the settle |
| `maxAttempts` | `Int` | Copied from fixed per-type config at creation. Never client-settable |
| `lastError` | `String?` | The most recent error message |
| `runAt` | `DateTime?` | When it should next be attempted. Backoff target while `FAILED`, `null` once terminal |
| `startedAt` | `DateTime?` | Start of the current claim |
| `lastHeartbeatAt` | `DateTime?` | Refreshed every 30s while the job is actively running |
| `finishedAt` | `DateTime?` | Set only when the job reaches a terminal state |
| `idempotencyKey` | `String` | Unique per account with `@@unique([accountId, idempotencyKey])` |
| `createdAt` / `updatedAt` | `DateTime` | |

Plus `result Json?` (the job's own outcome), and related rows: one `JobAttempt`
per run (never overwritten on retry), an optional `JobOutput` (a URL reference,
never binary output in the database), and any `WebhookDelivery` rows.

### The status list is the point

```
                     ┌───────────── backoff elapsed ─────────────┐
                     ▼                                            │
  QUEUED ──claim──► PROCESSING ──ok──► SUCCEEDED (terminal)        │
     ▲                   │                                        │
     │                   ├─retryable, attempts left──► FAILED ─────┘
     │                   │                          (will run again)
     └───────────────────┤
                         ├─non-retryable, or attempts exhausted──► DEAD (terminal)
                         │
                         └──heartbeat stale > 10min──► FAILED, requeued
```

`FAILED` and `DEAD` are different states and conflating them is the most common
mistake in a job system:

- **`FAILED` means it will run again.** The attempt failed but the job is still
  alive: it holds `lastError`, and it holds a `runAt` in the future. It is not
  terminal, nothing is watching it for a human, and no `finishedAt` is set.
- **`DEAD` means it has exhausted its retries and needs a human.** The attempt
  was non-retryable, or it was the last permitted attempt. `finishedAt` is set
  and `runAt` is `null`, so it can never be claimed again.

The only two terminal states are `SUCCEEDED` and `DEAD`. **No code path moves a
job out of a terminal state** — not a retry, not an admin action, not a webhook
redelivery.

The decision lives in one place, `settleAttemptFailure()`
(`modules/queue/settle.ts:104`):

```ts
const isExhausted = !failure.retryable || job.attempts >= job.maxAttempts;
const nextStatus = isExhausted ? JobStatus.DEAD : JobStatus.FAILED;
```

Retryability is never inferred from an HTTP status as the general rule. Every
executor returns an explicit `RETRYABLE` / `NON_RETRYABLE` outcome; status-code
mapping is a convenience inside HTTP-backed types only, because PDF generation
and image processing can fail for reasons that have no HTTP status at all.

`DEAD` jobs are visible at `/dead-letters` in the dashboard and via
`modules/jobs/list-dead-jobs.ts`.

## How a job flows

```
POST /api/v1/jobs
  → 256KB check (413)
  → rate limit (429)
  → per-account concurrent + daily caps (429)
  → idempotency: (accountId, idempotencyKey) unique — replay returns the same
    job with 200, a reused key with a different payload is 409
  → insert QUEUED, runAt = now
  ← 202 { id, status: "QUEUED", ... }   (a replay of the same key: 200, same id)

GET /api/v1/jobs/:id
  ← 200 with the current status, attempts, lastError and result
  → 404 for both "no such job" and "not your job", so the endpoint cannot be used
    to confirm that someone else's job id is real

worker loop
  → claimNextJob: SELECT ... FOR UPDATE SKIP LOCKED + set PROCESSING, one
    transaction, so no two workers can take the same job
  → heartbeat every 30s for the whole duration of execution
  → executor returns RETRYABLE / NON_RETRYABLE
  → settleAttemptSuccess | settleAttemptFailure
  → if a webhook endpoint is registered, deliver it with an HMAC signature
    (capped at 3 attempts; delivery failure never changes the job's status)
```

A stalled job is requeued **only** because its `lastHeartbeatAt` went stale, not
because it has been running a long time — otherwise a slow but healthy job would
be executed twice, duplicating emails and webhooks.

## Requirements

Each row points at the code that satisfies it. "Verified" means a test asserts the
behaviour, not merely that the code reads correctly.

| # | Requirement | Where | Verified |
|---|---|---|---|
| 1 | Job table with the full status lifecycle including `dead` | `prisma/schema.prisma:80`, `JobStatus` at :37 | yes — `dead-letter-view`, `worker-claim` |
| 2 | Enqueue returns 202 immediately, doing no work | `createJob()` — modules/jobs/create-job.ts:70; 202 at app/api/v1/jobs/route.ts:128 | yes — `jobs-route`, `double-submit` |
| 3 | Idempotency key enforced at the database | `@@unique([accountId, idempotencyKey])` schema.prisma:103; P2002 handled at create-job.ts:88 | yes — `double-submit`, incl. a 5-way race |
| 4 | Atomic claim, two workers cannot take one job | modules/queue/claim.ts:61 — `FOR UPDATE SKIP LOCKED` + guarded UPDATE, one statement | yes — `worker-claim` |
| 5 | Concurrency cap in configuration | `WORKER_CONCURRENCY`, default 10 — worker/config.ts:13 | yes — `worker-claim` |
| 6 | Exponential backoff with jitter | modules/retry/backoff.ts:34 — `min(30s · 2^(n-1), 30min)` + jitter | yes — `backoff` (12 tests) |
| 7 | Idempotent work | modules/jobs/outputs.ts:76 `produceOutputOnce()`, `JobOutput.jobId @unique` | yes — `job-output` |
| 8 | Stuck job recovery | heartbeat at modules/queue/heartbeat.ts; sweep at modules/queue/sweep.ts | yes — `stuck-job-sweep` |
| 9 | Dead-letter view | `/dead-letters`, modules/jobs/list-dead-jobs.ts | yes — `dead-letter-view` |
| 9b | **…with manual retry** | **not built — a v2 item, see below** | **no** |
| 10 | Status endpoint | `GET /api/v1/jobs/:id` — app/api/v1/jobs/[jobId]/route.ts:30 | yes — `job-status-read` |

Row 9 is half-built on purpose. The **view** is done and read-only. **Manual
retry is not**, and adding it would breach the phase gate: the PRD states "No
dead-letter queue with manual replay tooling … in v1" (Section 1, line 37), repeats
it in the v1 exclusion list (Section 13, line 351), and lists "Dead-letter queue
with manual replay from the dashboard" as a **v2 candidate** (line 359). AGENTS
rule 22 forbids building it early. So a `DEAD` job currently needs a new job
submitted by hand with a fresh idempotency key, which the unique constraint makes
possible — it is not re-runnable in place. Say so and treat it as a scope change,
not a bug.

## Repository layout

```
/app            Next.js routes and Server Components only. Route handlers are
                thin and call into /modules; they hold no business rules.
/modules        All business logic, by domain: auth, jobs, retry, queue,
                webhooks, abuse.
/worker         The standalone process. Imports /modules for shared logic,
                owns its own lifecycle, and holds one executor per job type.
/lib            Cross-cutting technical utilities only (db, ratelimit, auth).
                Never imports /modules; /modules never imports /app.
/prisma         Schema and migrations.
/tests          /unit for per-module rules, /integration for cross-module flows.
```

Any `if` that decides whether something is *allowed* or *retryable* belongs in
`/modules`, never in `/app` or `/worker/executors`.

## Current status

Implemented and covered by tests: the ten requirements above (except 9b), plus
API key issuance/rotation as module functions, job listing, and the read-only
dashboard (`/jobs`, `/dead-letters`).

`npm test` (unit) passes 85/85. **`npm run test:integration` is currently
unrunnable**: `.env` points at `localhost:5433` and the `renderflow` role's
password is rejected, so every DB-backed test errors in its `before()` hook on
`PrismaClientInitializationError`. That is an environment fault, not a code fault,
but it does mean the integration column above is asserted from the code and the
recorded evidence (`evidence/EVIDENCE.md:309`, 88/88) rather than from a run today.

Not built yet: the other five executors. Only `WEBHOOK_CALL` is registered in
`worker/executors/registry.ts`, so a job of any other type is never claimed and
stays `QUEUED` — it is deliberately not burned to `DEAD` by attempts that could
never have done anything. Registering an executor is a visible, deliberate
change. Also not built: API key issuance/rotation endpoints (keys are currently
provisioned by script), and anything from v2/v3 — no job priority, no delayed or
recurring scheduling, no account roles, no dead-letter replay tooling (row 9b), no
billing.
