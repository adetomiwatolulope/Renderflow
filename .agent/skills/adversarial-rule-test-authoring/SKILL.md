---
name: adversarial-rule-test-authoring
description: Writing tests for any task that touches a Question-3 "must never" rule, a coding-standard.md guard, or a database-schema.md invariant. Load before marking any task's Question 6 checklist complete.
---

## What this teaches
How to write a test that actively tries to break a rule, not just a happy-path test (CS-14).

## Technique by rule category
- **Race on a unique constraint (idempotency):** fire two concurrent submissions with the same `(accountId, idempotencyKey)` and differing payloads; assert one returns `200` with the original job and the other returns `409` with nothing created. Also test matching-payload reuse returns the existing job regardless of its current status.
- **Double-claim on the same job:** simulate two concurrent claim attempts against the same `QUEUED` row; assert exactly one succeeds and the other finds no eligible row (proves the `FOR UPDATE SKIP LOCKED` + atomic status-set actually works, not just that the code compiles).
- **Stall/heartbeat requeue:** fake the clock (or seed `lastHeartbeatAt` directly) to simulate a stale heartbeat past the 10-minute timeout; assert requeue fires. Then simulate a heartbeat that keeps updating past what *would* be claim-time-based staleness; assert it is **not** requeued — this is the specific bug PR-RETRY-003 exists to prevent.
- **Cross-account access:** attempt to fetch/act on another account's job by a known or guessed ID; assert `403`, not a filtered empty result (SEC-4).
- **Oversized payload:** submit a payload over 256KB; assert `413` and confirm no `Job` row was created at all.
- **Mismatched idempotency payload:** covered under the race case above, as a non-concurrent single-request variant too.
- **Malformed webhook URL:** register `http://...`; assert `422`.
- **SSRF probe (if the task touches webhook delivery or a fetch-a-URL job payload):** point the URL at a private/loopback address; assert the fetch is rejected before any request leaves the process.
- **AI adapter failure modes** (if the task touches `/modules/ai`): run the same fixture suite (success, malformed response, timeout, rate-limit, invalid provider value) against whichever adapter changed (AI-14).

## Must never
- Ship a task with only happy-path coverage for a rule that has a "never" statement attached to it.
- Use a real third-party call (a real AI provider, a real Flutterwave sandbox hit) in an automated test — fake the boundary.