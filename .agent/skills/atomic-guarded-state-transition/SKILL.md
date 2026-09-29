---
name: atomic-guarded-state-transition
description: Any state change that depends on current row state — job claiming, idempotency-key insert, per-account cap admission, API key rotation, heartbeat-stall requeue. Load before writing a conditional update anywhere in /modules or /worker.
---

## What this teaches
How to express a "check current state, then write" as one atomic operation instead of a race-prone read-then-write.

## The pattern
Never: `findUnique` → inspect in application code → `update`.
Always: one of —
- A conditional `updateMany` with the required current state expressed in `where`, then assert exactly one row changed. Zero rows changed means the precondition was already false — treat that as the rejection outcome, not an error to retry blindly.
- A unique constraint doing the enforcement for you (e.g., `(accountId, idempotencyKey)`), where a constraint violation (Prisma P2002) is the expected rejection signal, not a 500 (CS-4).
- `SELECT ... FOR UPDATE SKIP LOCKED` inside one transaction that also performs the state write (PR-QUEUE-001, PR-QUEUE-003), for job claiming specifically.

## Where this applies in this project
- **Job claiming** — select + `status = PROCESSING` + claim time, one transaction (PR-QUEUE-003).
- **Idempotency key** — the unique constraint is the guard; payload-match comparison happens in application code only after the constraint resolves which row is authoritative (PR-TECH-004, PR-IDEM-002).
- **Abuse caps** — concurrent-job and daily-submission checks (PR-ABUSE-001) are evaluated against the single shared definition in `/modules/abuse` (DB-8) — never redefined locally at a second call site.
- **API key rotation** — new key issuance and prior-key invalidation happen together; there is never a moment where two keys are simultaneously active (PR-AUTH-002).
- **Heartbeat-stall requeue** — only fires off `lastHeartbeatAt` staleness, never off original claim time (PR-RETRY-003); the transition back to `QUEUED` is itself a guarded write with the stale-heartbeat condition in `where`.

## Must never
- Let a status transition happen from two different call sites — each transition (`claimJob`, `markSucceeded`, `markFailed`, `requeueStalled`) is one named function, and it verifies the current state is a legal from-state before writing (CS-3).
- Treat a constraint violation as a server error.