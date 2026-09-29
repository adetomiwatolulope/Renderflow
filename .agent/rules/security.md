---
trigger: always_on
---

# security.md — Build Rules: Application Security

Scope: authentication, authorization, input/output handling, secrets, logging, headers, outbound HTTP.
Precedence: PRD (features) > AGENTS.md (process) > this file. If this file conflicts with either, follow them and flag the conflict.
Every rule here is a failure condition. Cite SEC-n in the Question 6 checklist when touched.

## Rules

**SEC-1 API key hashing.** API keys are high-entropy, machine-generated secrets — not user-chosen passwords — so a slow adaptive hash (Argon2id/bcrypt) is the wrong tool here: it would make the per-request auth lookup (`@@index([hashedKey])`) needlessly expensive at scale. Hash with a fast, non-reversible cryptographic hash (e.g., SHA-256) over the raw key, and look up by the resulting hash. Never store the raw key. Never use reversible encryption.

**SEC-2 Dashboard session, once one exists.** PR-AUTH-005 says the dashboard authenticates via the API key through a login form, but the PRD does not specify what happens after that (a session cookie? re-submitting the key per request?). This is unresolved. **Do not silently invent a session mechanism.** If a task requires one, flag it and propose the most restrictive option (a short-lived, HttpOnly, Secure, SameSite=Strict signed session token, never the raw API key itself persisted in a cookie or localStorage) rather than building something undocumented.

**SEC-3 No self-promotion, no roles to escalate into.** v1 has no role system (AGENTS Question 2 area, PR-AUTH-005) — there is exactly one credential per account. Do not build any endpoint or code path that creates a second privilege tier, an admin account, or a way for one account's key to act as another's, even internally.

**SEC-4 Authorization is account-scoped on every resource fetch by ID.** After validating the API key, every job, attempt, or webhook endpoint fetched by ID also confirms it belongs to the caller's account (AGENTS rule 2). A missing check is a 403. Test the cross-account case specifically, not just "no key at all."

**SEC-5 Mass assignment is closed.** Never pass or spread a request body into a Prisma create or update. Pick each accepted field explicitly. Never client-writable: `accountId`, `status`, `attemptCount`, `maxAttempts`, `result`, `lastError`, `lastHeartbeatAt`, `claimedAt`, `completedAt`, `hashedKey`, `secret` (AGENTS rule 5, 7).

**SEC-6 Output is allowlisted.** Responses use explicit `select` or DTOs. Never return `hashedKey`, the webhook `secret` (outside its one-time reveal, per design-system-rule.md DS-5), or another account's data.

**SEC-7 Injection and rendering.** No string-built SQL (see database-schema.md DB-9). Job payloads, error text, and AI provider output are never rendered with `dangerouslySetInnerHTML`; they render escaped (design-system-rule.md DS-7).

**SEC-8 Server-only boundary.** Modules and `/lib` code that touch the database, the queue, or secrets import `server-only`, so a client import fails the build. Secrets never use a `NEXT_PUBLIC_` name and never appear in client components.

**SEC-9 CSRF and GET.** No state change on GET. Mutating route handlers that use cookie auth verify the request Origin. The webhook *registration* endpoint (caller registering their own callback URL) is a normal authenticated mutation and follows this rule; it is not the same thing as outbound webhook *delivery* (SEC-12), which has no cookie auth to protect in the first place.

**SEC-10 Abuse limits.** Rate-limit the API per key, and rate-limit the dashboard login form, per PR-TECH-006's Postgres-backed counter — never an in-memory one (AGENTS Question 2). If the stack has no shared counter mechanism ready, stop and flag it rather than shipping a per-instance approximation.

**SEC-11 Dashboard login does not enumerate.** A failed dashboard login returns one generic message whether the account/key combination exists or not.

**SEC-12 Outbound webhook delivery is a live SSRF surface — validate every delivery, not just registration.** The worker makes an HTTP request to a URL the caller fully controls (`WebhookEndpoint.url`). This is a direct path for a caller to make RenderFlow's own trusted infrastructure issue requests to internal services (cloud metadata endpoints, internal databases, localhost, private IP ranges) on their behalf.
  - `https://` is required (design-system-rule.md aside — this is enforced server-side per PR-WEBHOOK-001), but scheme alone is not enough.
  - Before every delivery attempt (not just at registration), resolve the hostname and reject the request if it resolves to a private, loopback, link-local, or otherwise non-public IP range. Re-check on every delivery, not only once at registration, since DNS can change after registration (DNS rebinding).
  - Do not let the HTTP client follow redirects automatically to an unvalidated destination; either disable redirect-following or re-validate the destination IP at each hop.
  - This check lives in `/modules/webhooks`, in one function, called by every delivery path — never re-implemented per call site.

**SEC-13 Logging and errors.** Never log raw API keys, the webhook signing secret, or full job payloads that may contain caller-sensitive data — log job and attempt IDs, not their contents. Clients receive generic error bodies — no stack traces, no Prisma error text.

**SEC-14 Transport and headers.** HTTPS only outside local dev, with HSTS. Send `X-Content-Type-Options: nosniff`. Deny framing (`frame-ancestors 'none'`).