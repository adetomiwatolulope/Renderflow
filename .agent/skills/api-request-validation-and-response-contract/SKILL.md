---
name: api-request-validation-and-response-contract
description: Creating or editing a route handler under /app/api/v1/*. Load before implementing any new or modified API endpoint.
---

## What this teaches
The required order of checks and the exact status code each failure maps to, so no check is skipped or sequenced wrong.

## Ordered steps (do not reorder)
1. **Auth.** Missing or invalid API key → `401` (PR-AUTH-001). No further processing past this point without a resolved account.
2. **Rate limit.** Check the Postgres-backed per-key counter (PR-TECH-006, SEC-10) before doing any other work — never an in-memory counter. Excess → `429`.
3. **Account scope.** Any resource referenced by ID (a job, a webhook endpoint) is confirmed to belong to the caller's account (PR-AUTH-004, SEC-4) — check this even when the ID is a guessable-looking value. Mismatch → `403`.
4. **Payload size.** For job creation, reject over 256KB **before the job row is created** (PR-JOB-008) → `413`.
5. **Idempotency / payload match** (job creation only). Existing key + matching payload → return the existing job, `200` (not `201`). Existing key + mismatched payload → `409`, nothing created (PR-IDEM-002).
6. **Field-level validation.** Reject `priority`, `scheduledFor` (not accepted in v1 — PR-JOB-001, PR-JOB-006/007) and any client-submitted `maxAttempts` (PR-RETRY-001) → `422` or `400` with field errors, never silently dropped.
7. **Webhook URL scheme**, where relevant: `http://` → `422` (PR-WEBHOOK-001).
8. **Call exactly one module function.** The handler itself contains no `if` that decides allowed/retryable/over-cap (CS-11) — it parses input, calls a module, maps the result.
9. **Response shaping.** Use an explicit `select`/DTO — never return `hashedKey`, a webhook `secret` outside its one-time reveal, or another account's data (SEC-6).
10. **Unexpected failure** → generic `500` body; details to server log only, never a stack trace or Prisma error text to the client (SEC-13, CS-10).

## Must never
- Accept `accountId`, `status`, `attemptCount`, `maxAttempts`, `result`, `lastError`, or `lastHeartbeatAt` from a request body (CS-7, SEC-5).
- Return a filtered/redacted result instead of an explicit denial status.
- Spread a request body into a Prisma create/update (SEC-5) — pick fields explicitly.