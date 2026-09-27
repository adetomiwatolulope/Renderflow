---
trigger: always_on
---

# coding-standard.md — Build Rules: Code

Scope: all TypeScript in /app, /modules, /worker, /lib, /tests.
Precedence: PRD (features) > AGENTS.md (process) > this file. If this file conflicts with either, follow them and flag the conflict.
Every rule here is a failure condition, not a preference. When a task touches a rule, cite its ID (CS-n) in the Question 6 checklist.

## Rules

**CS-1 Types are never bypassed.** No `any`, no `@ts-ignore`/`@ts-expect-error` to silence a real error, and no `as` assertion on request, webhook, or provider-response data. External data is parsed into a type; an assertion is not validation.

**CS-2 Enums are exhaustive.** Every switch or mapping over `JobType`, `JobStatus`, `AttemptOutcome`, or `WebhookDeliveryStatus` ends in a `never` exhaustiveness check, so a new value is a compile error. No string literal stands in for an enum value.

**CS-3 One writer per status field.** Each transition of `Job.status` (`claimJob`, `markSucceeded`, `markFailed`, `requeueStalled`) and `WebhookDelivery.status` is written by exactly one named function in `/modules`. That function checks the current state is a legal from-state, performs the write, and updates related fields (`attemptCount`, `completedAt`) in the same operation. Only the transitions AGENTS.md rule 6 and the PRD define exist — `SUCCEEDED`/`FAILED` have no way out (PR-JOB-003).

**CS-4 Guarded writes are conditional, not read-then-write.** Job claiming, the idempotency-key check, and the per-account cap check (PR-ABUSE-001) all depend on current state — express the check as part of the write (`updateMany` with the state in `where`, asserting exactly one row changed; or a unique constraint) never a `findUnique` followed by `update`. A unique-constraint violation (Prisma P2002, e.g. `(accountId, idempotencyKey)`) is a normal rejection, never a 500.

**CS-5 The heartbeat is part of the execution loop, not a side task.** While a job is `PROCESSING`, `lastHeartbeatAt` is updated on the fixed interval by the same code path that is actively executing the job — never by a separate timer that could keep running after the executor has crashed or hung (PR-RETRY-003). If the executor cannot report progress (e.g., it's blocked on a single long synchronous call), that job type's suitability for the default heartbeat interval is an open item, not something to route around.

**CS-6 Every JobAttempt row is append-only.** No code path updates or deletes a prior `JobAttempt`. A retry creates a new row with the next `attemptNumber` (PR-RETRY-005).

**CS-7 Identity and authority come from the server.** `accountId`, `status`, `attemptCount`, `maxAttempts`, `result`, `lastError`, and `lastHeartbeatAt` come from the session (API key lookup) or module logic — never from a request body, query string, or hidden field (AGENTS rule 5, 7).

**CS-8 The server clock decides time.** Heartbeat staleness, backoff scheduling, the daily submission-cap window, and rate-limit windows are all evaluated server-side in UTC. A client-supplied timestamp is never used in a decision.

**CS-9 Retry outcomes are explicit, never inferred by absence of error.** Every executor returns `RETRYABLE` or `NON_RETRYABLE` directly (PR-RETRY-002). An uncaught exception in an executor is not automatically `RETRYABLE` by default — it is caught, logged, and mapped to an outcome deliberately, so a bug in an executor cannot silently masquerade as a transient failure retried forever.

**CS-10 Errors are not swallowed.** No empty `catch`, and no `catch` that returns a default result from a guarded function. Permission failure → typed error → 403. Validation failure → 4xx with field errors. Unexpected failure → generic 500 body (details to server log only).

**CS-11 Handlers are thin.** Code in `/app` and `/worker/executors` parses input, calls exactly one module function, and maps the result. Any `if` that decides allowed/not-allowed, retryable/not-retryable, or over-cap/under-cap is a defect and moves to `/modules`.

**CS-12 Every mutation validates on the server**, even when the caller's SDK or the dashboard already validated.

**CS-13 Dependencies are decisions.** Do not add, replace, or major-upgrade a package as a side effect of a task — especially auth, queue, payment, AI-provider SDK, or date/time libraries. Only `/modules/billing` (once it exists) may import a Flutterwave client; only the AI adapters in `/modules/ai` may import a Claude or DeepSeek SDK.

**CS-14 Guards are proven by failing tests.** For every guard a task adds or touches, at least one test attempts the forbidden action and asserts the rejection (cross-account access, a second claim on an already-claimed job, an oversized payload, a mismatched idempotency-key payload, an http:// webhook URL). A suite of happy-path tests alone means the task is not done.