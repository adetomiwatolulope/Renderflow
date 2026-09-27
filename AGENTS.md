# AGENTS.md — RenderFlow Build Agent Rules

## Question 1 — What is this project?

RenderFlow is a background job processing platform. Developers submit jobs (PDF generation, image processing, email delivery, AI requests, webhook calls, or custom work) through an API instead of running that work inside their own request path. RenderFlow queues each job, executes it, retries recoverable failures under a defined backoff policy, and notifies the caller by webhook when a job reaches a final state.

- **Version being built:** v1, as defined in `RenderFlow_PRD_v2.md`. v1 assumes RenderFlow executes job logic itself (self-execution) rather than only tracking state for an external worker — this is explicitly unconfirmed in the PRD (Section 1, Open Question 1). Build against self-execution. If that assumption is ever overturned, treat it as a scope change requiring new instructions, not something to resolve mid-task.
- **Who it is for:** Backend developers integrating the API (persona: Priya), the engineer operating the worker in production (persona: Tomás), and operators using the read-only dashboard (persona: Ada — she authenticates with the same account API key as the API itself; there is no separate dashboard identity in v1).
- **Source of truth:** `RenderFlow_PRD_v2.md` (v2, post-review). If this AGENTS.md and the PRD disagree on a *feature* decision, the PRD wins. If they disagree on *process/behavior* (how you work, not what you build), this file wins. Anything the PRD marks `[ASSUMPTION]` is the current working rule, not optional, until an Open Question in PRD Section 14 resolves it.
- **What this file is not:** not a feature list, not a PRD summary. Every feature you build must trace to a specific PRD requirement ID (PR-XXX-NNN). This file only governs how you behave while building those requirements.

---

## Question 2 — What is locked?

Do not change, swap, "improve," or substitute any of these, even if you believe an alternative is technically better. If you think one is wrong, stop and flag it — do not silently work around it.

### Stack
- **Framework:** Next.js, App Router, TypeScript strict mode. No `any`, no `@ts-ignore` to bypass a real type error.
- **Database:** PostgreSQL, accessed only through Prisma. No raw SQL except a parameterized Prisma `$queryRaw` when a Prisma query genuinely cannot express the query.
- **Queue:** PostgreSQL is the only queue implementation in v1. No Redis, no external queue service (SQS, BullMQ, etc.), under any circumstance in v1 (PR-TECH-001). Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED` or equivalent (PR-QUEUE-001).
- **Worker:** a standalone Node.js/TypeScript process, separate from the Next.js web app, long-running (not serverless). Exactly one worker process instance runs in v1 (PR-TECH-002). Do not build for, or assume, more than one instance.
- **Rate limiting:** a Postgres-backed counter (a rolling-window table keyed by API key). Never an in-memory counter (PR-TECH-006). Redis for rate limiting only is a deliberate, flagged v2 decision — never a default fallback.

### Payment provider
- **Flutterwave is the only payment provider**, for whenever billing is built. Do not add Stripe, Paystack, or any other processor, even as a fallback or for testing convenience.
- **This is a locked *choice*, not a locked *scope*.** The PRD (Section 8, Section 14 Question 9) has NOT decided whether v1 ships with billing, or what the pricing model is. Locking Flutterwave answers "which provider, if any billing is ever built" — it does not authorize building billing now. See the phase gate in Question 3.
- The PRD's current schema (Section 10) has no billing-related model at all — no `Subscription`, no `amount`, no `currency` field. Any billing work requires a new, explicitly approved schema extension before it requires any Flutterwave code.

### Architecture boundaries (already decided, not open for restructuring)
- Webhook delivery to callers is performed by the worker process, not the web app, after a job's final state is committed (PR-TECH-005).
- Binary job outputs (generated PDFs, processed images) are never stored in the database — only a URL reference (PR-JOB-009, PR-TECH-007).
- The idempotency constraint (`accountId`, `idempotencyKey`) is enforced at the database level via a unique constraint, not only in application code (PR-TECH-004).
- API is versioned under `/v1/`.

---

## Question 3 — What must never happen

Every rule below is a direct order. **Breaking any rule on this list means the task failed, even if the code runs, even if the feature appears to work in a demo.** Each rule points to its PRD requirement where one exists.

1. **Never store an API key in plaintext.** Hash it. Show it to the account owner only once, at creation or rotation (PR-AUTH-003).

2. **Never let one account read, list, or act on another account's jobs.** Every request scopes to the account that owns the API key used — check this even when a job ID is known and guessable (PR-AUTH-004).

3. **Never issue more than one active API key per account at a time.** Rotating a key immediately invalidates the previous one (PR-AUTH-002).

4. **Never invent a separate dashboard identity.** The dashboard authenticates with the same account API key as the API itself, submitted through a login form. Do not build a password system or session-based identity in v1 (PR-AUTH-005).

5. **Never accept `priority`, `scheduledFor`, or `maxAttempts` as client-submitted fields on job creation.** `priority` and delayed scheduling do not exist in v1. `maxAttempts` is set internally from the fixed per-type config — it is never client-settable (PR-JOB-001, PR-JOB-007).

6. **Never move a job out of `SUCCEEDED` or `FAILED`.** These are terminal. No code path — not a retry, not an admin action, not a webhook redelivery — transitions a job out of a terminal status (PR-JOB-003).

7. **Never accept a job payload larger than 256KB.** Reject with 413 before the job row is created (PR-JOB-008).

8. **Never make retry configuration runtime- or per-account-configurable in v1.** `maxAttempts` and backoff timing are fixed, defined in application code, not the database. There is no API surface to change them (PR-RETRY-001).

9. **Never infer retryability from an HTTP status as the general rule.** Every job execution attempt must return an explicit `RETRYABLE` or `NON_RETRYABLE` outcome from the code that runs that specific job type. HTTP-status-to-outcome mapping is a convenience default inside HTTP-backed job types only — it must not be the only mechanism, because PDF_GENERATION, IMAGE_PROCESSING, and CUSTOM jobs can fail for reasons with no HTTP status at all (PR-RETRY-002).

10. **Never requeue a job based on time-since-claim alone.** Requeuing a stalled job is driven only by `lastHeartbeatAt` going stale past the timeout (default 10 minutes since the last heartbeat, not since claim time). The worker must update the heartbeat on an interval (default 30s) for the entire duration a job is actively processing. Getting this wrong double-executes legitimately slow jobs — duplicate emails, duplicate webhook calls (PR-RETRY-003).

11. **Never overwrite a prior attempt's record on retry.** Every attempt, successful or not, gets its own `JobAttempt` row (PR-RETRY-005).

12. **Never create a duplicate job for a reused idempotency key with a matching payload.** Return the existing job (200), regardless of its current status (PR-IDEM-002).

13. **Never silently accept a reused idempotency key with a mismatched payload.** Reject with 409 Conflict. No job is created or returned (PR-IDEM-002).

14. **Never treat a retry attempt as a new job submission.** Retries operate on the existing `Job` row (PR-IDEM-003).

15. **Never let two workers execute the same job concurrently.** Claiming a job (select + set `PROCESSING`) is one atomic transaction (PR-QUEUE-001, PR-QUEUE-003).

16. **Never treat the per-process concurrency limit as a system-wide limit.** It is a per-process cap (default 10), and it is only equal to the system-wide cap because v1 runs exactly one worker process instance (PR-QUEUE-004, PR-TECH-002). Do not write code that assumes multiple instances coordinate this limit.

17. **Never accept a webhook URL that isn't `https://`.** Reject `http://` with 422 — an unencrypted transport defeats the HMAC signing on the payload (PR-WEBHOOK-001).

18. **Never let webhook delivery failure change a job's status.** A job's `SUCCEEDED`/`FAILED` state is independent of whether the webhook was ever successfully delivered. Cap webhook retries at 3 attempts; after that, mark the delivery `FAILED` and stop — do not retry indefinitely (PR-WEBHOOK-004).

19. **Never let job submission bypass the per-account cost caps.** Every account has a concurrent non-terminal job cap (default 100) and a daily submission cap (default 5,000), enforced regardless of billing status — return 429 on excess. This applies to every job type, but matters most for `AI_REQUEST`, which carries real third-party cost per job (PR-ABUSE-001).

20. **Never add AI-provider-specific business logic.** No built-in provider integrations, no prompt templates, no cost tracking, no provider fallback, no streaming. `AI_REQUEST` is retried under the exact same `RETRYABLE`/`NON_RETRYABLE` rule as every other job type — no special case (Section 6).

21. **Never build billing or any Flutterwave code until the owner explicitly starts that work.** Until then: no Flutterwave SDK, no keys, no checkout, no webhook handler, and no billing-related schema model exists in the codebase. This is currently true because Section 8 states no metering/billing ships in v1, and Section 14 Question 9 (pricing model) is unresolved — locking Flutterwave as the eventual provider (Question 2) does not lift this gate.
    - Once billing is explicitly scoped: all Flutterwave webhook events must be signature-verified before any state change. Amounts are stored as whole integers in the smallest currency unit — never float or decimal. The client never determines a price; it is computed and stored server-side. Payment processing is idempotent by transaction reference (duplicate/replayed events have no second effect).

22. **Never build anything the roadmap places in v2 or v3 early**, even if implementing v1 cleanly seems to want it: delayed/recurring scheduling, job priority, account roles, dead-letter replay tooling, cross-instance concurrency limits, any billing/metering, AI-provider-specific logic, or a second worker process instance (Section 13).

---

## Question 4 — How is the work arranged?

```
/renderflow
├── /app                          # Next.js App Router — routes + Server Components only
│   ├── /(dashboard)               # read-only operator dashboard (API-key login, PR-AUTH-005)
│   └── /api
│       └── /v1                    # public API, route handlers — thin, call into /modules only
│           ├── /jobs
│           ├── /webhooks          # webhook endpoint *registration* (caller-facing), not delivery
│           └── /keys              # API key issuance/rotation
│
├── /modules                      # ALL business logic lives here, by domain
│   ├── /auth                     # API key issuance, hashing, scoping, dashboard login
│   ├── /jobs                     # job creation, idempotency, status transitions, payload validation
│   ├── /retry                    # retry taxonomy (RETRYABLE/NON_RETRYABLE), backoff calculation
│   ├── /queue                    # claim logic (FOR UPDATE SKIP LOCKED), heartbeat, stall detection
│   ├── /webhooks                 # outbound delivery, HMAC signing, retry/backoff for delivery
│   ├── /abuse                    # concurrent/daily cap enforcement (PR-ABUSE-001)
│   └── /billing                  # DOES NOT EXIST until billing is explicitly scoped (rule 21).
│                                  # When it does: only module allowed to import a Flutterwave client.
│
├── /worker                       # the standalone worker process (separate deployable from /app)
│   ├── index.ts                  # process entrypoint: polling loop, claim, execute, heartbeat
│   └── /executors                # one executor per JobType, each returning RETRYABLE/NON_RETRYABLE
│
├── /lib                          # cross-cutting technical utilities only (no business rules)
│   ├── /db                       # Prisma client singleton
│   ├── /ratelimit                # Postgres-backed rate limiter (PR-TECH-006)
│   └── /auth                     # session/API-key verification helpers used by /modules
│
├── /prisma
│   └── schema.prisma              # extend, don't restructure without explicit instruction
│
├── /tests
│   ├── /unit                      # per-module business rule tests
│   └── /integration               # cross-module flows (e.g., stall → requeue → single execution)
│
└── AGENTS.md                      # this file
```

**Placement rule:** any `if` that decides whether something is *allowed* or *retryable* (auth scope, idempotency match, retry outcome, cap exceeded) belongs in `/modules`, never in `/app` or `/worker/executors`. Route handlers and executors call a module function and act on its result.

**Separation rule:** `/lib` never imports from `/modules`. `/modules` never imports from `/app`. `/worker` imports from `/modules` for shared logic (claim, retry, heartbeat) but owns its own process lifecycle. Only `/modules/billing`, once it exists, may import a Flutterwave SDK — no other module talks to Flutterwave directly.

---

## Question 5 — How should the code look?

- **TypeScript strict mode, no exceptions.** No `any`. No suppressed type errors.
- **Node.js and all dependencies on their current LTS versions** at setup time. Do not pin old versions for convenience; do not jump to a non-LTS bleeding-edge release.
- **Small, named functions over clever one-liners.** A reviewer should know what a function checks or does from its name alone.
- **Every status transition is an explicit function** (`claimJob()`, `markSucceeded()`, `markFailed()`, `requeueStalled()`), not an inline `.update({ status: X })` scattered across call sites — this is the one place each rule in Question 3 lives and gets tested.
- **No magic strings for enums.** Use the Prisma-generated enum types (`JobType`, `JobStatus`, `AttemptOutcome`, `WebhookDeliveryStatus`) everywhere. Every switch or mapping over one of these ends in a `never` exhaustiveness check, so a new enum value is a compile error, not a silent gap.
- **Guarded writes are conditional, not read-then-write.** Claiming a job, enforcing the idempotency key, and enforcing abuse caps all depend on current state — express the check as part of the write (`updateMany` + assert one row changed, or a transaction), never a `findUnique` followed by `update`.
- **Server-side validation on every mutation**, even where client validation exists. The server never trusts client input, especially `status`, `maxAttempts`, `priority`, or anything resembling a price.
- **Comments explain why, not what**, and only where a Question 3 rule is being enforced and isn't obvious from the function name.
- **No commented-out code, no TODO-and-abandon.** Unfinished work is either not merged, or is an explicit open item in your task output.

---

## Question 6 — What counts as done?

For every task, before reporting it complete, produce a checklist covering:

- [ ] The code builds with zero errors and zero TypeScript strict-mode warnings.
- [ ] Every requirement ID this task touches is listed, with a one-line note on how it's satisfied (e.g., "PR-QUEUE-003: claim and status-set share one transaction").
- [ ] Every "must never happen" rule from Question 3 relevant to this task has been checked against the actual code, not assumed.
- [ ] Any new Prisma model/field change includes the migration, and any new query includes its matching index in the same migration.
- [ ] Auth/scope checks are in place on every new route or module function, with a test proving cross-account access is denied.
- [ ] No money/amount field uses float or decimal (only relevant once billing exists — confirm it stays untouched otherwise).
- [ ] Tests exist for the specific business rule(s) this task implements — including at least one test that tries to break the rule (a race on idempotency, a stall that shouldn't double-execute, a mismatched payload reuse), not just a happy-path smoke test.
- [ ] Nothing from a later phase (v2, v3 per Section 13) was built early, and no Flutterwave/billing code was touched unless billing was explicitly scoped in this task.
- [ ] Anything you were unsure about is listed explicitly at the end of your output (see Question 7) rather than silently resolved by guessing.

---

## Question 7 — What does the agent do when unsure?

- **Never invent a feature, field, or scope the PRD doesn't define.** If a task seems to need something undefined — a new status value, a new endpoint, a new cap — stop and flag it as an open item. Do not guess and ship.
- **Never build ahead of v1.** If a task seems to require a v2/v3 item (delayed scheduling, account roles, billing, multiple worker instances) to feel "complete," do not build it because you're already in there. Flag the dependency and stop at the v1 boundary.
- **Check PRD Section 14 (Open Questions) before improvising an answer.** Ten unresolved questions are already named there — self-execution vs. external worker, account deletion semantics, job retention policy, worker deployment target, and others. If a task touches one, build against the PRD's stated working assumption (where one exists) and flag it; do not resolve the open question yourself.
- **Never fill an ambiguity with the most convenient guess and move on silently.** Where genuinely ambiguous, pick the most restrictive reading (deny by default, reject rather than guess, don't retry rather than retry blindly), implement that, and say plainly what you assumed and why.
- **Never paper over uncertainty with more code.** If you don't know how a rule should behave, don't write speculative branching logic to "cover all the cases." Write the smallest correct implementation for the case you're sure about, and name the uncertain case as an open question instead of guessing at it in code. This is the specific failure mode this file exists to prevent — an agent unsure whether a job type is HTTP-backed should not invent a fallback status-inference scheme; it should implement the explicit `RETRYABLE`/`NON_RETRYABLE` return for the cases it's sure about and flag the rest.
- **When two rules seem to conflict**, stop and surface the conflict explicitly rather than picking one silently. Point to both requirement IDs (or, for the Flutterwave case, point to Question 2's provider lock versus rule 21's phase gate).
