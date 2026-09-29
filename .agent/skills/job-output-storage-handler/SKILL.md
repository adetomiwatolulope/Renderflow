---
name: job-output-storage-handler
description: Any code that produces or serves a binary job output — the PDF_GENERATION and IMAGE_PROCESSING executors, and anything under /lib/storage. Load before building either executor's output-handling step, or before touching storage code.
---

## Read first
**No storage provider is decided** (PRD Open Question 8). This blocks full completion of two job types. Do not silently pick a provider to make progress — build what can be built without one (payload validation, the RETRYABLE/NON_RETRYABLE contract, everything up to the point of writing the output) and flag the dependency (UP status note).

## Ordered steps (apply once a provider exists, or design the abstraction now regardless)
1. **One abstraction, one importer.** Only `/lib/storage` may import the storage SDK, whatever it ends up being — every executor calls `/lib/storage`, never the provider directly (UP-1).
2. **Default to private, account-scoped access** — this is a flagged assumption, not a confirmed decision (UP-2). The object is not publicly readable by a guessable URL; access requires a signed URL generated only after confirming the requesting account owns the job. If the owner wants public-by-default, that's a product decision to surface, not to pick silently.
3. **Server-generate the object key from the job ID** — never from anything caller-supplied (UP-3). `result` stores a delivery URL or a stable reference `/lib/storage` can re-sign, never the raw key.
4. **Signed URLs are short-lived and never persisted** — default 900s (flagged, unconfirmed value). Never store, cache, or log a signed URL; re-sign on each `GET /v1/jobs/:id` (UP-4).
5. **Never overwrite an existing object.** A retried job that produces a new output gets a new key; a prior partial write is not silently replaced (UP-5).
6. **Fail closed on any storage error.** A write or signing failure is a `RETRYABLE` outcome, same category as a network error — never fall back to an unsigned or public URL just to make the attempt look successful (UP-6).

## Must never
- Store the binary output inside a Postgres column (PR-JOB-009, PR-TECH-007) — URL/reference only.
- Build a "temporary" hardcoded provider choice without flagging that Open Question 8 is still open.