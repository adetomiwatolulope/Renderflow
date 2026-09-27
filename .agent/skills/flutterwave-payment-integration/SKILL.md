---
name: flutterwave-payment-integration
description: Any task that mentions billing, Flutterwave, checkout, subscriptions, or a pricing model. Load only when a task explicitly states this work is now authorized — never loaded proactively.
---

## Read first — the gate
**MB-1 is load-bearing.** Until the owner explicitly scopes billing (names what's being charged for, and the pricing model per Section 14 Question 9 is actually decided), there is no Flutterwave SDK, key, checkout flow, webhook handler, or billing schema model anywhere in the codebase. If a task even seems adjacent to this, stop and confirm the gate is actually lifted before writing anything — including a "minimal" version to unblock progress.

## Ordered steps, once the gate is confirmed lifted
1. **Confirm the pricing model was handed to you as an explicit decision** — per-job, per-compute-time, flat tier, free tier or not. Do not infer one from the job schema or default to "the simplest" (MB-3).
2. **The schema extension is its own separate approval**, on top of the phase gate (`Subscription`, `amount`, `currency` fields don't exist yet) — clearing MB-1 doesn't authorize the migration by itself (MB-4, DB-11). Use prisma-schema-and-migration-discipline for the migration itself, plus this file's money-specific rules.
3. **Client sends a plan/tier identifier only** — never an amount, currency, or price. The server computes and stores the expected amount/currency before redirecting to Flutterwave checkout (MB-5).
4. **Webhook handling, in this exact order:**
   a. Read the raw body as text before parsing anything.
   b. Verify the signature using Flutterwave's documented mechanism, constant-time comparison. Failure → `4xx`, no database write (MB-6).
   c. Confirm the transaction server-to-server via Flutterwave's own verification endpoint — don't trust the webhook payload alone.
   d. Only flip billing state if the confirmed amount, currency, and transaction reference all match a pending record the server itself created. Any mismatch → no state change, logged for review (MB-7).
5. **Idempotency by transaction reference**, using a durable table with a unique constraint — never in-memory/per-instance deduplication (MB-8, same reasoning as SEC-10's rate limiter).
6. **Money conversion happens in exactly one function**, integer minor units internally, converted to/from Flutterwave's major-unit decimals using integer or string arithmetic — never `parseFloat(x) * 100`, never float equality (MB-9, DB-5).
7. **Currency travels with every amount explicitly** — never assume a single hardcoded currency (MB-10).
8. **A failed/abandoned/pending payment changes nothing.** No refund, chargeback, proration, or invoice logic exists without an explicit separate instruction naming it (MB-12).
9. **If billing ever gates an abuse-cap tier:** a downgrade or payment failure never cancels, fails, or orphans a job already `QUEUED`/`PROCESSING` at the moment billing state changes (MB-11 — flagged assumption, fires once this feature exists).
10. **Secrets and modes:** Flutterwave keys and webhook secret are server-only env vars; test keys never run in production, live keys never run in dev/CI; log by transaction reference and status only, never the raw payload or secrets (MB-13).

## Must never
- Let a client-side redirect or query parameter change billing state — only a verified server-to-server webhook does (MB-6).
- Add Stripe, Paystack, or any processor other than Flutterwave, even for testing (MB-2, AGENTS Question 2).