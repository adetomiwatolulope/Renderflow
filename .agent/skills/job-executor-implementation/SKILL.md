---
name: job-executor-implementation
description: Building or editing a /worker/executors file for any JobType (PDF_GENERATION, IMAGE_PROCESSING, EMAIL_DELIVERY, AI_REQUEST, WEBHOOK_CALL, CUSTOM). Load before writing a new job-type executor or touching an existing one.
---

## What this teaches
The fixed sequence every executor must follow, so a new job type doesn't quietly skip a required step.

## Ordered steps
1. **Validate the payload shape for this job type first**, inside the executor, even though PR-JOB-008's size cap was already enforced at submission. A malformed-but-under-256KB payload is this executor's problem, not the API's.
2. **Enter execution and start the heartbeat cycle in the same code path that does the work** (CS-5) — never a separate timer. Update `lastHeartbeatAt` every 30s (PR-RETRY-003) for the full duration.
3. **Do the actual work.** If this is `AI_REQUEST`, do not write provider logic here — call into `/modules/ai` per the ai-provider-adapter-builder skill; this executor only orchestrates.
4. **Capture the outcome explicitly.** Every path — success, provider error, uncaught exception — resolves to exactly `RETRYABLE` or `NON_RETRYABLE` (PR-RETRY-002, CS-9). An uncaught exception is caught and deliberately mapped; it is never allowed to default to `RETRYABLE` by absence of handling.
5. **Write the `JobAttempt` row** with attempt number, start/end time, duration, outcome, and error code/message if failed (PR-OBS-001, PR-RETRY-005). Never update or overwrite a prior attempt (CS-6).
6. **If the job type produces a binary output** (`PDF_GENERATION`, `IMAGE_PROCESSING`), hand off to `/lib/storage` per job-output-storage-handler — never write the binary into `result` directly (PR-JOB-009).
7. **Return control to the worker loop**, which transitions the job's terminal state via the one named function for that transition (`markSucceeded`/`markFailed`) — the executor itself never writes `Job.status` directly (CS-3).

## Must never
- Add job-type-specific business logic that leaks outside this one executor file.
- Infer `RETRYABLE` from an HTTP status as the *general* rule — that mapping is a convenience default only inside HTTP-backed job types' own code (PR-RETRY-002).
- Let `AI_REQUEST` behave differently from other job types in retry/backoff (AI-9, AI-10).