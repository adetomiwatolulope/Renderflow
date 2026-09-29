---
trigger: glob
---

# money-billing.md — Build Rules: Money & Billing (Flutterwave)

Scope: /modules/billing, the Flutterwave webhook route, and any amount anywhere in the system.
Precedence: PRD (features) > AGENTS.md (process) > this file. If this file conflicts with either, follow them and flag the conflict.
**Status: mostly inactive by design.** The pricing model is PRD Open Question 9, unresolved. This file exists to hold the invariants that must be true no matter what the pricing model turns out to be, and to make the phase gate enforceable on its own — an agent working a billing task should be able to read this file alone and know it isn't authorized to start.
Every rule here is a failure condition. Cite MB-n in the Question 6 checklist when touched.

## Rules

**MB-1 Phase gate — this is the load-bearing rule.** Until the owner explicitly scopes billing work (names what's being charged for and gets the pricing model decided), there is no Flutterwave SDK, key, checkout flow, webhook handler, or billing-related schema model anywhere in the codebase (AGENTS rule 21). A task that seems to need one of these stops and flags it — it does not build a "minimal" version to unblock itself.

**MB-2 Flutterwave is the only provider, once billing exists.** Do not add Stripe, Paystack, or any other processor, even for testing convenience (AGENTS Question 2).

**MB-3 The pricing model is a prerequisite, not an inference.** Per-job, per-compute-time, a flat tier, a free tier — the PRD names all four as live options with no decision made (Section 14, Question 9). Do not infer one from the job schema or default to "the simplest one" to make progress. The first billing task is capturing the actual decision as an explicit instruction; nothing past MB-1's gate gets built without it, including checkout UI, plan identifiers, or pricing logic.

**MB-4 Schema extensions are gated on top of the phase gate.** A `Subscription`-equivalent model, an `amount` field, a `currency` field — none exist yet (database-schema.md DB-11). Getting past MB-1 does not itself authorize the migration; the schema change is its own approval step.

**MB-5 The server owns the price.** Once a pricing model is decided, the client sends only a plan or tier identifier — never an amount, currency, or reference. The server computes and stores the expected amount and currency before redirecting to Flutterwave checkout.

**MB-6 The webhook is verified before anything else happens.** Read the raw body as text before parsing. Verify the signature using Flutterwave's documented mechanism for the API version in use, with a constant-time comparison. On failure: reject with 4xx, no database write. A client-side redirect or query parameter never changes billing state — only a verified server-to-server webhook does.

**MB-7 Confirm before flipping any billing state.** After the signature check, confirm the transaction server-to-server through Flutterwave's own verification endpoint. Only change state if the confirmed amount, currency, and transaction reference all match a pending record the server itself created. Any mismatch: no state change, logged for review.

**MB-8 Processing is idempotent by transaction reference.** A duplicate or replayed webhook event has no second effect. This needs a durable table of processed transaction references with a unique constraint (part of the MB-4 schema extension) — in-memory or per-instance deduplication is forbidden, same reasoning as the rate limiter in security.md SEC-10.

**MB-9 Integer money, one conversion point.** Amounts are integers in minor units internally (database-schema.md DB-5). Flutterwave uses major-unit decimals; convert in exactly one function, using integer or string arithmetic — never `parseFloat(x) * 100`, never float equality.

**MB-10 Currency is explicit, never hard-coded.** An amount always travels with its currency once the schema supports one (MB-4). Do not assume a single currency across the whole system without that being part of the explicit pricing-model decision in MB-3.

**MB-11 Billing state changes never retroactively touch in-flight work.** [ASSUMPTION — the interaction is plausible but not confirmed] If billing ever gates something (for example, a higher PR-ABUSE-001 cap on a paid tier), a downgrade or payment failure must never cancel, fail, or orphan a job that is already `QUEUED` or `PROCESSING` at the moment billing state changes. Whether billing gates the abuse caps at all is not decided — this rule only fires once that decision is made, but it fires from day one of that feature, not as an afterthought.

**MB-12 Failure states change nothing.** A failed, abandoned, or pending payment leaves billing state unchanged. Refunds, chargebacks, proration, and invoices are not in the PRD and are not built without an explicit instruction naming them.

**MB-13 Secrets and modes.** Flutterwave keys and the webhook secret are server-only env vars. Test keys never run in production; live keys never run in dev or CI. Never log secrets; log webhook events by transaction reference and status only, never the raw payload.