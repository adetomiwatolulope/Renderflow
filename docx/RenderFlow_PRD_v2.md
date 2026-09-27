# RenderFlow — Product Requirements Document (v2)

*This is a revision of v1. Every change below was made in response to a live cross-functional review (Skeptic / Author / Engineer / Product Lead / Judge). Where a v1 requirement was reworded, cut, or split, that is noted inline.*

## 1. Product Summary

RenderFlow is a background job processing platform built on Next.js, TypeScript, Prisma, and PostgreSQL. Developers submit jobs to RenderFlow through an API instead of running slow or unreliable work (PDF generation, image processing, AI requests, email delivery, third-party API calls) inside their own request path. RenderFlow queues each job, executes it asynchronously, tracks every attempt, retries recoverable failures under a defined backoff policy, and notifies the caller by webhook when a job reaches a final state. Every job's full history — status, attempts, errors, timing — is recorded and queryable.

**[ASSUMPTION — unconfirmed, load-bearing]** This PRD assumes RenderFlow executes job logic itself (self-execution), rather than only tracking status while an external worker performs the work and reports back. This is not settled; it is the first item in Section 14. If the answer turns out to be "external worker reports back," the following sections need to be substantially reworked: Section 5 (PR-JOB, PR-RETRY — the retry/failure model assumes RenderFlow owns execution), Section 6 (the AI pipeline assumes RenderFlow calls the provider), and Section 10 (`JobAttempt.errorCode`/`errorMessage` assume RenderFlow catches the failure directly; an external-worker model would need a callback API instead).

## 2. Problem Statement

Applications that perform slow or unreliable work directly inside a request (PDF generation, image processing, AI calls, email sends, third-party API calls) create three recurring problems:

- **Blocked requests.** A user-facing request stays open while slow work runs, increasing latency and timeout risk.
- **Silent failures.** A transient error (a provider timeout, a rate limit, a dropped connection) fails the whole operation with no retry, even when retrying would likely succeed.
- **No audit trail.** When something does fail, there is no record of what was attempted, how many times, or why it failed, which makes debugging and customer support reactive rather than evidence-based.

RenderFlow removes this class of work from the request path and gives it a durable, retryable, observable lifecycle.

## 3. Goals and Non-Goals

### Goals (v1)
- Accept a job submission over an authenticated API in under 200ms, p50 and p95 (PR-API-001). *Measured in Section 11 — see the Submission Latency row.*
- Guarantee a submitted job is either executed to completion or marked FAILED after exhausting retries — no job is silently dropped.
- Prevent duplicate execution of the same logical job through caller-supplied idempotency keys.
- Retry recoverable failures automatically under a configurable backoff policy, without manual intervention.
- Give the caller a complete, queryable history of every attempt for every job.
- Notify the caller of terminal job outcomes via webhook, without requiring polling.

### Non-Goals (v1)
- RenderFlow does not perform the actual work of a job type itself using any RenderFlow-specific business logic beyond generic execution and retry (see Open Question 1 above for the deeper ambiguity this rests on).
- No delayed or recurring (cron-style) job scheduling.
- No account roles or team-based permissions — one API key per account, used for both API and dashboard access (see PR-AUTH-005).
- No UI for end users of the caller's application; the dashboard is for the developer/account operating RenderFlow, not their customers.
- No usage-based billing implementation (pricing model is an open question). **Note:** this does not mean no cost controls — see PR-ABUSE-001 in Section 8, which is a distinct, non-billing decision.
- No dead-letter queue with manual replay tooling (a FAILED job is queryable but not re-submittable through a dedicated UI in v1).

## 4. User Personas

**Priya, Backend Developer (primary persona).** Integrates RenderFlow's API into her company's product to offload PDF generation and email delivery. She cares about a predictable API contract, clear error codes, and not having to build her own retry logic. She reads job status either by polling the API or by receiving a webhook.

**Tomás, Platform/DevOps Engineer.** Operates the RenderFlow worker process in production. He cares about worker crash recovery, queue lag under load, and being able to see stuck or failing jobs before they become a customer-facing incident.

**Ada, Support/Ops Engineer (secondary).** Uses the dashboard to look up why a specific job failed for a specific customer, without needing direct database access. **She authenticates the same way Priya's application does — see PR-AUTH-005** — there is no separate identity for her in v1; she holds (or is handed) the account's API key.

## 5. Functional Requirements

### PR-AUTH — Authentication
- **PR-AUTH-001.** Every API request outside of a health-check endpoint requires a valid API key sent as a bearer token. A missing or invalid key returns 401.
- **PR-AUTH-002.** Each account has exactly one active API key at a time in v1. Rotating a key immediately invalidates the previous one.
- **PR-AUTH-003.** API keys are stored hashed (never in plaintext). The key is shown to the account owner only once, at creation or rotation time.
- **PR-AUTH-004.** Every request is scoped to the account that owns the API key used. An account can never read, list, or act on another account's jobs, regardless of job ID guessability.
- **PR-AUTH-005 *(new)*.** The dashboard authenticates by having the user submit their account's API key through a login form; there is no separate password or session-based identity in v1. Anyone holding the API key can access both the API and the dashboard, including anyone playing the Ada persona. This is accepted for v1 and is revisited if account roles are built in v2 (see Section 13).

### PR-JOB — Job Lifecycle
- **PR-JOB-001.** A job is created via `POST /v1/jobs` with: `type` (one of the six enum values), `payload` (JSON object), and `idempotencyKey` (string, required). `priority` and `scheduledFor` are not accepted in v1 (see PR-JOB-006, PR-JOB-007). `maxAttempts` is **not** an accepted field — see PR-RETRY-001.
- **PR-JOB-002.** A created job starts in status `QUEUED`.
- **PR-JOB-003.** Valid job statuses are: `QUEUED`, `PROCESSING`, `SUCCEEDED`, `FAILED`. These are the only values `Job.status` may hold. `SUCCEEDED` and `FAILED` are terminal; no code path transitions a job out of a terminal status.
- **PR-JOB-004.** `GET /v1/jobs/:id` returns the job's current status, its `payload`, its `result` (on success) or last error (on failure), and its full attempt history.
- **PR-JOB-005.** `GET /v1/jobs` supports filtering by `status` and `type`, and pagination via cursor. Results are scoped to the requesting account (PR-AUTH-004).
- **PR-JOB-006.** Jobs are processed in FIFO order within an account, by `createdAt`. There is no priority field in v1.
- **PR-JOB-007.** A job executes immediately upon being picked up by the worker. There is no delayed or scheduled execution in v1; `scheduledFor` is rejected if present in the request body.
- **PR-JOB-008.** `payload` is capped at 256KB (measured as the serialized JSON byte size). A request exceeding this is rejected with 413 before the job is created.
- **PR-JOB-009.** A job type that produces a binary output (a generated PDF, a processed image) stores only a URL reference to that output in `result`, never the binary itself. Where the output is stored is out of scope for this PRD (see Open Question 8).

### PR-RETRY — Retry and Backoff
- **PR-RETRY-001 *(reworded)*.** Each `JobType` has a **fixed retry configuration for v1, defined in application code, not the database**: `maxAttempts` (default 5, with per-type overrides in a static config object in code, e.g. `EMAIL_DELIVERY: 3`) and a backoff schedule of `min(30s * 2^(attemptNumber - 1), 30min)`. There is no runtime or per-account configurability in v1, and no API surface to change it. Runtime-configurable retry policy is a v2 candidate (Section 13). [ASSUMPTION: exact base/cap/per-type values; confirm before build.]
- **PR-RETRY-002 *(replaced)*.** Every job execution attempt returns one of exactly two outcomes, decided by the code that runs that specific job type: `RETRYABLE` or `NON_RETRYABLE`. This is a direct outcome the execution step must produce, not an inference from an HTTP status — it must work identically for job types that call an external service (EMAIL_DELIVERY, WEBHOOK_CALL, AI_REQUEST) and job types that may fail for entirely local reasons (PDF_GENERATION, IMAGE_PROCESSING, CUSTOM). For job types backed by an HTTP call, the *default* mapping within that job type's execution code is: network failures and 5xx responses → `RETRYABLE`; 4xx responses → `NON_RETRYABLE`. This mapping is a convenience default inside each HTTP-backed job type's own code, not the general rule for the system.
- **PR-RETRY-003 *(rewritten)*.** While a job is `PROCESSING`, the worker updates `Job.lastHeartbeatAt` on a fixed interval (default: every 30 seconds) for as long as execution continues. A job is only automatically returned to `QUEUED` if `lastHeartbeatAt` has gone stale past a defined timeout (default: 10 minutes since the last heartbeat, **not** since the original claim time). This distinguishes a genuinely dead worker (heartbeat has stopped) from one that is still alive but slow (heartbeat keeps updating), so a legitimately long-running job is never requeued and double-executed while it is still actively running. This requeue counts against `maxAttempts`.
- **PR-RETRY-004.** When `maxAttempts` is reached without success, the job transitions to `FAILED` and no further automatic attempts occur.
- **PR-RETRY-005.** Every individual attempt, successful or not, is recorded as its own `JobAttempt` row (see PR-OBS-001). Retrying never overwrites a prior attempt's record.

### PR-IDEM — Idempotency
- **PR-IDEM-001.** `idempotencyKey` is required on every job submission and is unique per account (not globally unique — two accounts may use the same key value for different jobs).
- **PR-IDEM-002 *(extended)*.** Submitting a job with an `idempotencyKey` that already exists for that account returns the existing job (200, not 201) instead of creating a duplicate, regardless of the existing job's current status — **provided the submitted `payload` matches the payload stored on the existing job.** If the payload does not match, the request is rejected with **409 Conflict**, and no job is returned or created. The comparison is an exact deep-equality check on the serialized JSON payload.
- **PR-IDEM-003.** A retry attempt for an existing job is never treated as a new job submission; retries operate on the same `Job` row and increment its attempt count.

### PR-QUEUE — Queue and Worker
- **PR-QUEUE-001.** The queue is implemented in PostgreSQL. The worker claims the next eligible job using `SELECT ... FOR UPDATE SKIP LOCKED` (or equivalent) to prevent two worker instances from claiming the same job.
- **PR-QUEUE-002.** A job is eligible for claiming when `status = QUEUED` and (`nextAttemptAt IS NULL OR nextAttemptAt <= now()`).
- **PR-QUEUE-003.** Claiming a job is atomic: the same transaction that selects the job also sets `status = PROCESSING` and records the claim time. No two workers execute the same job concurrently.
- **PR-QUEUE-004 *(renamed)*.** **Per-process concurrency limit:** the number of jobs a single worker process instance executes at once is a configurable value, default 10. This is not a system-wide limit — see PR-TECH-002 for the v1 deployment topology this number assumes.

### PR-WEBHOOK — Outbound Notifications
- **PR-WEBHOOK-001 *(extended)*.** An account may register one webhook URL (`WebhookEndpoint`) to receive job completion/failure notifications. Registering a second URL replaces the first in v1. **Only `https://` URLs are accepted; a `http://` URL is rejected with 422** (payload signing in PR-WEBHOOK-003 is undermined if the transport itself is unencrypted). *Implementation note (not a formal requirement): the dashboard should send a test ping when a webhook URL is registered or changed, so a mistyped URL is caught immediately rather than discovered on the next real failure.*
- **PR-WEBHOOK-002.** When a job reaches `SUCCEEDED` or `FAILED`, RenderFlow sends a `POST` to the account's registered webhook URL containing the job ID, type, final status, and result/error summary, within 5 seconds of the state change under normal load.
- **PR-WEBHOOK-003.** Each webhook delivery is signed with an HMAC using a per-account secret, sent in an `X-RenderFlow-Signature` header, so the caller can verify authenticity.
- **PR-WEBHOOK-004.** A webhook delivery that fails (non-2xx response or timeout) is retried up to 3 times with backoff. A delivery that still fails after 3 attempts is marked `WebhookDelivery.status = FAILED` and is not retried further; the job's own status is unaffected by webhook delivery failure.

### PR-OBS — Observability
- **PR-OBS-001.** Every attempt at executing a job creates a `JobAttempt` row recording: attempt number, start time, end time, duration, outcome, and error message/code if failed.
- **PR-OBS-002.** A dashboard (web UI, authenticated per PR-AUTH-005) lists jobs with status, type, and creation time, and lets the operator drill into a single job's full attempt history.
- **PR-OBS-003.** The API exposes the same attempt history programmatically (PR-JOB-004); the dashboard is a view over the API, not a separate data path.

### PR-ABUSE — Cost and Abuse Controls *(new section)*
- **PR-ABUSE-001 *(new)*.** Each account has a soft cap on concurrent non-terminal jobs (`QUEUED` + `PROCESSING`, default: 100) and a daily job-submission cap (default: 5,000), enforced independently of any future billing plan, purely as a cost and abuse control — this matters most for `AI_REQUEST` jobs, where a single job can carry real, variable third-party cost. Exceeding either cap returns 429 on new submissions until existing jobs clear or the daily window resets.

## 6. AI Processing Pipeline

RenderFlow treats `AI_REQUEST` as an ordinary job type in v1. It carries no AI-provider-specific business logic: no built-in provider integrations, no prompt templates, no cost tracking, no provider fallback, and no streaming of partial results. The caller supplies whatever the actual execution step needs (provider identifier, model, prompt, parameters) inside `payload`, exactly as it would for any other job type.

**AI_REQUEST jobs are retried under the same generic `RETRYABLE`/`NON_RETRYABLE` rule as any other job type (PR-RETRY-002).** RenderFlow applies no AI-provider-specific interpretation of errors, response formats, or rate limits; whatever code executes the AI_REQUEST job type is responsible for reporting `RETRYABLE` or `NON_RETRYABLE` using the same default HTTP-status convenience mapping every other HTTP-backed job type uses, not a special AI-specific rule.

This section stays narrow because of the same open question that governs every job type: whether RenderFlow executes the work itself or only tracks state for an external worker (Section 1, Open Question 1). If RenderFlow does end up executing jobs itself, AI-specific execution logic (a per-provider adapter) is a v2+ decision, not part of this PRD. AI_REQUEST jobs are subject to PR-ABUSE-001's caps like every other job type, and are called out there specifically because of their variable real-world cost.

## 7. Technical Requirements

- **PR-TECH-001 (Queue mechanism).** PostgreSQL-backed queue using row-level locking (`FOR UPDATE SKIP LOCKED`) per PR-QUEUE-001–003. No Redis, no external queue service, in v1.
- **PR-TECH-002 (Worker model) *(extended)*.** A standalone Node.js/TypeScript process, separate from the Next.js web app, long-running (not serverless), polling the database on an interval (default: 1 second) for eligible jobs. **v1 runs exactly one worker process instance.** True cross-instance concurrency limiting (needed once more than one worker instance runs) is out of scope until horizontal worker scaling is designed, and is a v2 roadmap item (Section 13). Polling introduces up to 1 second of avoidable queue lag and a constant background query load per worker process, independent of actual job volume; this is accepted for v1 for simplicity. Postgres `LISTEN`/`NOTIFY`-based push wake-up, which would push a signal the moment a job is inserted instead of waiting for the next poll, is a v2 candidate if the queue-lag targets in Section 11 are not met under load (see also the corresponding Section 9 risk row).
- **PR-TECH-003 (Concurrency handling).** Governed by PR-QUEUE-003 (atomic claim) and PR-QUEUE-004 (per-process concurrency cap, single instance in v1 per PR-TECH-002).
- **PR-TECH-004 (Idempotency enforcement).** Enforced at the database level via a unique constraint on (`accountId`, `idempotencyKey`), not only in application code, so a race between two simultaneous submissions with the same key cannot create two jobs. The payload-match check in PR-IDEM-002 runs in application code after the constraint resolves which row is authoritative.
- **PR-TECH-005 (Webhook delivery).** Delivered by the worker process (not the web app) after a job's final state is committed, using the retry rules in PR-WEBHOOK-004. Delivery attempts are logged in `WebhookDelivery`.
- **PR-TECH-006 (API design) *(extended)*.** REST, JSON request/response bodies, versioned under `/v1/`. Rate-limited per API key (default: 100 requests/minute; 429 on excess). **Rate limiting is enforced with a Postgres-backed counter (a rolling-window table keyed by API key), not an in-memory counter, so it remains correct if the web app ever runs as more than one instance.** This adds one write per request. If load-testing shows this write is too costly at scale, introducing Redis for rate limiting only is a flagged, explicit v2 assumption requiring a deliberate decision to break the v1 stack lock — it is not a default fallback. [ASSUMPTION on the exact 100 req/min limit.]
- **PR-TECH-007 (Payload/result storage).** JSON payload and result fields stored directly in Postgres (`Json` columns), capped per PR-JOB-008. Binary outputs are never stored in the database (PR-JOB-009).

## 8. Business Model

Pricing model is an unresolved open question (Section 14): the options under consideration are per-job-processed, per-compute-time, and flat volume tiers, with or without a free tier. No metering, billing, or plan-limit enforcement is built in v1.

**This is distinct from cost and abuse control, which is not deferred.** See PR-ABUSE-001 (Section 5): every account has a hard concurrent-job and daily-submission cap regardless of billing status, specifically because unbounded submission — especially of `AI_REQUEST` jobs, which carry real third-party cost — is a financial exposure independent of whether or how RenderFlow eventually charges for usage. RenderFlow is usable end-to-end (submit, process, retry, observe) within those caps, without any billing gate, so that the pricing decision does not block v1 delivery. [ASSUMPTION]

## 9. Risks

| Risk | Category | Mitigation |
|---|---|---|
| Postgres-based queue does not scale past a certain job volume/throughput | Technical | **Load-test the queue at 10x projected v1 peak submission volume before GA. If p95 queue lag (Section 11) exceeds target at that volume, the LISTEN/NOTIFY change from Section 7 becomes mandatory before launch, not optional.** |
| A slow-but-alive job is mistaken for a dead worker and double-executed | Technical | Heartbeat-based stall detection (PR-RETRY-003) — requeue keys off a stale `lastHeartbeatAt`, not off original claim time |
| Two worker instances claim the same job under high concurrency | Technical | Atomic claim via `SELECT ... FOR UPDATE SKIP LOCKED` (PR-QUEUE-001–003) |
| Caller's webhook endpoint is down or slow, backing up delivery | Operational | Bounded retry count (PR-WEBHOOK-004); delivery failure never blocks job state |
| A misbehaving job type consumes disproportionate worker capacity, starving other jobs | Operational | Per-process concurrency cap (PR-QUEUE-004); true cross-instance caps deferred to v2 with multi-worker support |
| No account roles means a single leaked API key exposes all of an account's job data, including dashboard access | Operational | Key hashing and one-key rotation (PR-AUTH-002/003); scoped role model is a v2 candidate |
| Pricing model undecided, risking a v1 launch with no monetization path | Business | Ship v1 usable without billing; treat pricing as a fast-follow decision, not a launch blocker |
| Large or malicious payloads used to exhaust database storage | Technical | Hard payload size cap (PR-JOB-008) enforced before job creation |
| **Unbounded job submission volume, especially for AI_REQUEST, creates uncapped third-party cost exposure with no v1 billing gate** *(new)* | Business | PR-ABUSE-001: per-account concurrent-job and daily-submission caps, enforced independent of billing |
| **1-second polling interval creates avoidable queue lag and constant background query load regardless of actual job volume** *(new)* | Technical | Accepted for v1; LISTEN/NOTIFY-based push wake-up is a v2 candidate if queue-lag targets are missed under load (PR-TECH-002) |

## 10. Prisma Data Model

### Model Summary

| Model | Purpose |
|---|---|
| `Account` | A tenant. Owns jobs, an API key, and a webhook endpoint. |
| `ApiKey` | The single active authentication credential for an account, used for both API and dashboard access (PR-AUTH-005). |
| `Job` | One submitted unit of work and its current state, including heartbeat tracking for stall detection. |
| `JobAttempt` | One execution attempt against a job; append-only. |
| `WebhookEndpoint` | The single registered callback URL for an account; `https://` only. |
| `WebhookDelivery` | One delivery attempt of a job's outcome to the webhook endpoint. |

*Changes from v1: added `Job.lastHeartbeatAt` (supports the rewritten PR-RETRY-003). No `JobTypeConfig` table was added — PR-RETRY-001 was reworded instead to describe a fixed, code-level configuration for v1, since a data-backed per-type config was requirement text the v1 schema never actually supported.*

```prisma
// schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum JobType {
  PDF_GENERATION
  IMAGE_PROCESSING
  EMAIL_DELIVERY
  AI_REQUEST
  WEBHOOK_CALL
  CUSTOM
}

enum JobStatus {
  QUEUED
  PROCESSING
  SUCCEEDED
  FAILED
}

enum AttemptOutcome {
  SUCCEEDED
  FAILED
}

enum WebhookDeliveryStatus {
  PENDING
  DELIVERED
  FAILED
}

model Account {
  id              String            @id @default(cuid())
  name            String
  createdAt       DateTime          @default(now())
  apiKey          ApiKey?
  webhookEndpoint WebhookEndpoint?
  jobs            Job[]

  @@map("accounts")
}

model ApiKey {
  id         String    @id @default(cuid())
  account    Account   @relation(fields: [accountId], references: [id], onDelete: Restrict)
  accountId  String    @unique
  hashedKey  String    @unique
  prefix     String
  createdAt  DateTime  @default(now())
  rotatedAt  DateTime?

  @@index([hashedKey])
  @@map("api_keys")
}

model Job {
  id               String     @id @default(cuid())
  account          Account    @relation(fields: [accountId], references: [id], onDelete: Restrict)
  accountId        String
  type             JobType
  status           JobStatus  @default(QUEUED)
  idempotencyKey   String
  payload          Json
  result           Json?
  lastError        String?
  attemptCount     Int        @default(0)
  maxAttempts      Int        @default(5) // set internally from the fixed per-type config (PR-RETRY-001); not client-settable
  nextAttemptAt    DateTime?
  claimedAt        DateTime?
  lastHeartbeatAt  DateTime?  // updated by the worker every ~30s while PROCESSING; drives stall detection (PR-RETRY-003)
  createdAt        DateTime   @default(now())
  updatedAt        DateTime   @updatedAt
  completedAt      DateTime?

  attempts          JobAttempt[]
  webhookDeliveries WebhookDelivery[]

  @@unique([accountId, idempotencyKey])
  @@index([status, nextAttemptAt])
  @@index([status, lastHeartbeatAt])
  @@index([accountId, status])
  @@index([accountId, createdAt])
  @@map("jobs")
}

model JobAttempt {
  id            String          @id @default(cuid())
  job           Job             @relation(fields: [jobId], references: [id], onDelete: Restrict)
  jobId         String
  attemptNumber Int
  startedAt     DateTime
  finishedAt    DateTime?
  durationMs    Int?
  outcome       AttemptOutcome?
  errorCode     String?
  errorMessage  String?

  @@unique([jobId, attemptNumber])
  @@index([jobId])
  @@map("job_attempts")
}

model WebhookEndpoint {
  id         String   @id @default(cuid())
  account    Account  @relation(fields: [accountId], references: [id], onDelete: Restrict)
  accountId  String   @unique
  url        String   // must be https:// — enforced in application validation, not a DB constraint (PR-WEBHOOK-001)
  secret     String
  createdAt  DateTime @default(now())

  deliveries WebhookDelivery[]

  @@map("webhook_endpoints")
}

model WebhookDelivery {
  id            String                @id @default(cuid())
  job           Job                   @relation(fields: [jobId], references: [id], onDelete: Restrict)
  jobId         String
  endpoint      WebhookEndpoint       @relation(fields: [endpointId], references: [id], onDelete: Restrict)
  endpointId    String
  attemptNumber Int
  status        WebhookDeliveryStatus @default(PENDING)
  responseCode  Int?
  sentAt        DateTime?
  createdAt     DateTime              @default(now())

  @@index([jobId])
  @@index([endpointId, status])
  @@map("webhook_deliveries")
}
```

## 11. Success Metrics

*Reworked from v1: the single blended "time-to-completion" metric (with an undefined exclusion clause) is replaced with a per-job-type table. The single "job success rate" metric (which conflated RenderFlow's own reliability with caller input errors) is split into two.*

### Latency and throughput

| Metric | Definition | Target |
|---|---|---|
| Submission latency (p50) | Time for `POST /v1/jobs` to return, from receipt to response | ≤ 100ms |
| Submission latency (p95) | Same measure, 95th percentile | ≤ 200ms *(PR-API-001)* |
| Queue lag (p95) | Time from `Job.createdAt` to first `JobAttempt.startedAt` | ≤ 5 seconds |
| Webhook delivery success rate | DELIVERED ÷ (DELIVERED + FAILED) webhook deliveries | ≥ 98% |
| Worker crash recovery | Jobs auto-requeued via stall timeout (PR-RETRY-003) that later succeed | ≥ 95% |

### Time-to-completion, by job type

| Job type | Median target | p95 target |
|---|---|---|
| EMAIL_DELIVERY | ≤ 10s | ≤ 60s |
| WEBHOOK_CALL | ≤ 10s | ≤ 60s |
| AI_REQUEST | ≤ 10s | ≤ 60s |
| CUSTOM | ≤ 10s | ≤ 60s |
| PDF_GENERATION | ≤ 30s | ≤ 120s |
| IMAGE_PROCESSING | ≤ 30s | ≤ 120s |

### Reliability

| Metric | Definition | Target |
|---|---|---|
| System-attributable failure rate | Jobs that failed after exhausting retries on a `RETRYABLE`-tagged outcome (i.e., RenderFlow's own retry mechanism could not recover them) ÷ all completed jobs | ≥ 99% success (≤ 1% system-attributable failure) |
| Caller-error rate | Jobs that failed immediately on a `NON_RETRYABLE` outcome (i.e., the input itself was invalid) ÷ all completed jobs | Tracked for visibility; no target — this measures callers, not RenderFlow |
| Retry rate | Jobs with `attemptCount > 1` ÷ total completed jobs | ≤ 15% |

[ASSUMPTION: all numeric targets above are starting points for v1 and should be revisited against real traffic once launched.]

## 12. Assumptions

*Regenerated to reflect every correction applied in this revision.*

- RenderFlow executes job logic itself (self-execution); this is unconfirmed — see Section 1 and Open Question 1.
- Exponential backoff base of 30 seconds, doubling per attempt, capped at 30 minutes, with per-job-type overrides defined in application code, not the database (PR-RETRY-001).
- Heartbeat interval of 30 seconds and stall timeout of 10 minutes since the last heartbeat (not since claim time) before an unresponsive `PROCESSING` job is auto-requeued (PR-RETRY-003).
- Per-process worker concurrency default of 10 concurrent jobs (PR-QUEUE-004); v1 runs exactly one worker process instance (PR-TECH-002), so this is also the effective system-wide limit for v1.
- API rate limit of 100 requests/minute per API key, enforced with a Postgres-backed counter rather than in-memory (PR-TECH-006).
- Per-account cost/abuse caps of 100 concurrent non-terminal jobs and 5,000 daily submissions (PR-ABUSE-001).
- Worker polls the database every 1 second for eligible jobs; this is a known source of avoidable latency, accepted for v1 (PR-TECH-002).
- Worker deployment target is a long-running process, not serverless, because job execution time is not bounded (PR-TECH-002); the actual hosting choice is still an open question.
- Binary job outputs are stored outside RenderFlow and referenced by URL; where they are stored is unspecified and flagged as an open question (PR-JOB-009).
- Dashboard authentication reuses the account's API key as a bearer-token login with no separate session identity (PR-AUTH-005).
- Webhook URLs must be `https://`; `http://` is rejected (PR-WEBHOOK-001).
- V1 ships without any billing/metering implementation, regardless of which pricing model is eventually chosen, but does ship with non-billing cost caps (Section 8, PR-ABUSE-001).
- All numeric success-metric targets in Section 11 are placeholders pending real traffic data.

## 13. Phased Roadmap

**v1 (this PRD)**
- Job submission, idempotency (with payload-mismatch detection), FIFO queueing, heartbeat-based retry with backoff, attempt history, webhook notification (https-only), dashboard for read-only observability with API-key login, single API key per account, per-account cost/abuse caps.
- Explicitly out of scope: delayed/scheduled jobs, job priority, account roles, dead-letter replay tooling, cross-instance concurrency limits, any billing/metering, any AI-provider-specific logic, more than one worker process instance.

**v2 (candidate)**
- Delayed and recurring (cron-style) job scheduling.
- Job priority levels.
- Runtime-configurable, per-type (and possibly per-account) retry policy, backed by a real config table.
- Horizontal worker scaling, with true cross-instance concurrency limiting to replace the v1 per-process cap.
- Postgres `LISTEN`/`NOTIFY`-based push wake-up, if v1 load-testing shows polling latency misses the queue-lag target.
- Dead-letter queue with manual replay from the dashboard.
- Account roles (admin/member) and multiple API keys per account, replacing the shared-key dashboard login.
- Usage metering, once the pricing model (Section 8) is decided.
- Redis-backed rate limiting, only if the Postgres-backed counter proves too costly under real load — a deliberate, flagged decision, not a default.

**v3 (candidate)**
- Migration path off the Postgres-based queue if throughput requires it (e.g., Redis/BullMQ), per the mitigation in Section 9.
- AI-provider-specific pipeline features (provider fallback, cost tracking, streaming), contingent on resolving whether RenderFlow executes job logic itself.
- Multiple webhook endpoints per account with per-event-type routing.

## 14. Open Questions

| # | Question | Tradeoff |
|---|---|---|
| 1 | Does RenderFlow execute job logic itself (per-type handlers running inside RenderFlow), or does an external worker perform the work and report status back through the API? | Self-executing is simpler for the caller but makes RenderFlow responsible for every job type's runtime and failure modes. External execution keeps RenderFlow generic and unopinionated but pushes more integration work onto the caller and complicates "what counts as a retryable error." **This PRD assumes self-execution throughout (Section 1); confirming otherwise requires reworking Sections 5, 6, and 10.** |
| 2 | Does the platform need account-level roles (admin/member), or is one API key per account enough for v1? | Roles add access control granularity but add real scope (permission checks, invite flows) before v1 ships. v1 answer: no roles; dashboard and API share one key (PR-AUTH-005). |
| 3 | Do jobs need a priority field, or is FIFO sufficient? | Priority helps time-sensitive jobs jump the queue but complicates fairness and starvation handling for low-priority jobs. |
| 4 | Does a FAILED job need a separate dead-letter queue with manual replay, or is the FAILED state itself sufficient? | A dedicated DLQ gives operators a clear remediation workflow; relying on FAILED status alone is simpler but requires building replay logic later without a distinct queryable "needs attention" state. |
| 5 | Does the platform need per-account or global concurrency limits beyond the v1 per-process cap? | Per-account limits protect against one noisy tenant starving others but add another layer of queue-claim logic. v1 has only a per-process cap (PR-QUEUE-004), which is also the system-wide cap since v1 runs one worker instance. |
| 6 | What is the job history retention policy — indefinite, or a rolling window? | Indefinite retention is simplest for debugging and audit but grows storage and index size unboundedly. A rolling window bounds storage but requires an archival or deletion job and a decision on how long is "enough." |
| 7 | Where does the worker run in production — same infrastructure as the web app, or a separately deployed long-running process? | Co-locating is simpler to deploy but couples web and worker scaling/failure domains. A separate deployment isolates them but adds operational complexity (two things to deploy, monitor, and scale). |
| 8 | Where are binary job outputs (generated PDFs, processed images) actually stored? | This PRD assumes external object storage referenced by URL (PR-JOB-009) but does not specify the provider, ownership (RenderFlow's storage vs. the caller's), or access control model for that storage — this needs a decision before the relevant job types can be built. |
| 9 | What is the pricing model — per job processed, per compute time, or a flat volume tier? Is there a free tier? | Per-job pricing is simplest to explain and meter but doesn't account for jobs with wildly different resource costs (a webhook call vs. an AI request). Per-compute-time pricing is fairer but harder to meter accurately and explain to customers. A flat tier is easiest to bill but risks under- or over-charging heavy/light users. A free tier drives adoption but requires abuse controls beyond PR-ABUSE-001's flat caps. |
| 10 | *(new)* What does account deletion or offboarding mean: soft delete with data retained, hard delete cascading through jobs and attempts, or explicitly unsupported in v1? | The current schema's `onDelete: Restrict` on every relation off `Account` means an account with any job history cannot be deleted at the database level today — this happened by default, not by design decision, and needs an explicit answer before any account-deletion feature is built. |
