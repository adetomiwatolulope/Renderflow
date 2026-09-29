---
trigger: always_on
---

# upload-and-storage.md — Build Rules: Job Output Storage & Caller-Supplied Source URLs

Scope: any code that produces a binary job output (PDF_GENERATION, IMAGE_PROCESSING) and any code that fetches a URL supplied inside a job's payload.
Precedence: PRD (features) > AGENTS.md (process) > this file. If this file conflicts with either, follow them and flag the conflict.
**Status: no storage provider is named in the PRD.** This is PRD Open Question 8, unresolved. Two job types (`PDF_GENERATION`, `IMAGE_PROCESSING`) cannot be built to completion without this decision — do not build a full implementation of either job type's executor that silently picks a provider; flag the dependency and stop at whatever can be built without one (payload validation, the RETRYABLE/NON_RETRYABLE contract) until the owner decides.
Every rule here is a failure condition. Cite UP-n in the Question 6 checklist when touched.

## Rules — output storage (blocked on Open Question 8)

**UP-1 The provider stays behind one abstraction.** Whatever storage service is eventually chosen, only `/lib/storage` may import its SDK. No module talks to the storage provider directly, so the eventual choice is a config change, not a rewrite.

**UP-2 Outputs are private by default, scoped like everything else.** Every other resource in RenderFlow is account-scoped (AGENTS rule 2, security.md SEC-4); a generated PDF or image is no exception. [ASSUMPTION — the PRD doesn't say, defaulting to the most restrictive reading] The stored object is not publicly readable by a guessable URL; access goes through a short-lived signed URL, generated only after confirming the requesting account owns the job. If the owner intends outputs to be public-by-default instead, that's a real product decision, not a technical detail — flag it rather than picking either silently.

**UP-3 Keys are server-generated and opaque.** The object key is derived from the job ID, not from anything caller-supplied. `result` stores the delivery URL (or a stable reference `/lib/storage` can re-sign), never the raw storage key.

**UP-4 Signed URLs are short-lived and never persisted.** [ASSUMPTION, pending a real value] Default 900 seconds. A signed URL is never stored in the database, cached, or logged — `result` holds a reference `/lib/storage` re-signs on each `GET /v1/jobs/:id` call, not a URL baked in once and reused past expiry.

**UP-5 Objects are immutable once written.** A job's output, once stored, is never overwritten. If a job is retried and produces a new output, it gets a new key — the prior attempt's object (if it was ever written before the attempt failed) is not silently replaced.

**UP-6 Fail closed.** If storage write or signing fails, the job attempt fails with a `RETRYABLE` outcome (a storage outage is a transient infrastructure failure, same category as a network error per PR-RETRY-002) — never fall back to returning an unsigned or public URL to make the attempt "succeed."

## Rules — fetching caller-supplied source URLs (live now, not blocked)

**UP-7 Any URL inside a job payload that RenderFlow's own server fetches is a live SSRF surface, and gets the exact same treatment as outbound webhook delivery (security.md SEC-12).** If `IMAGE_PROCESSING` (or any job type) accepts a source URL in its payload and the executor fetches it server-side: resolve the hostname and reject private, loopback, link-local, and other non-public IP ranges before fetching; re-validate on every fetch attempt, not once at job creation (DNS rebinding); do not follow redirects to an unvalidated destination. This check lives in one shared function (`/lib/fetch-external` or equivalent), called by every executor that fetches a caller-supplied URL — never re-implemented per job type.

**UP-8 A fetched source is capped and typed before it's processed.** A max content-length and a content-type allowlist (matching what the job type actually expects — images for `IMAGE_PROCESSING`) are enforced before the fetched bytes are handed to any processing step. An oversized or wrong-type response is a `NON_RETRYABLE` outcome (it's a caller input problem, not a transient failure), not a crash or a silent pass-through.

**UP-9 Fetched source content is never treated as executable or interpreted.** Whatever library processes an image or generates a PDF runs against the raw bytes only — no code path evaluates fetched content as a template, a script, or markup with embedded logic.