---
trigger: always_on
---

# database-schema.md — Build Rules: Data Model & Migrations

Scope: prisma/schema.prisma, migrations, seeds, and every Prisma query.
Precedence: PRD (features) > AGENTS.md (process) > this file. If this file conflicts with either, follow them and flag the conflict.
Every rule here is a failure condition. Cite DB-n in the Question 6 checklist when touched.

## Rules

**DB-1 The PRD §10 schema is locked; changes are additive.** No rename, removal, or type change of any model, enum, or field. A destructive change (drop, rename, type change, adding NOT NULL to a populated column) needs an explicit instruction that names it.

**DB-2 Enums are closed.** A new `JobType`, `JobStatus`, `AttemptOutcome`, or `WebhookDeliveryStatus` value is a new business state. Stop and ask (AGENTS Q7); never add one "just in case."

**DB-3 Migration discipline.** Every schema change ships as a committed Prisma migration. Never run `prisma db push` or `migrate reset` outside a disposable local database. Never edit a migration that has been applied or merged — fix forward with a new one. Read the generated SQL before committing; any `DROP` or lossy `ALTER` stops the task.

**DB-4 An index ships with its query.** For every new query pattern, the same migration adds the matching index, or the PR names the existing `@@index` that serves it. The schema already anticipates the hot paths — verify a new query actually uses one of these before assuming a new index is needed:
- Claiming: `@@index([status, nextAttemptAt])`.
- Stall detection: `@@index([status, lastHeartbeatAt])`.
- The concurrent-job cap (PR-ABUSE-001): `@@index([accountId, status])`.
- The daily-submission cap (PR-ABUSE-001): `@@index([accountId, createdAt])`.
- Auth lookup: `@@index([hashedKey])` on `ApiKey`.

**DB-5 Money columns, whenever they exist, are whole integers in the smallest currency unit.** Never `Float` or `Decimal`. This has no live target today — there is no billing model in the schema (AGENTS Question 2) — but the rule is recorded now so the first migration that adds one gets it right. Prisma `Int` is 32-bit (max 2,147,483,647); confirm the range holds for the launch currency before choosing a type, or flag it.

**DB-6 Terminal jobs and attempt history are immutable.** Never UPDATE or delete a `Job` whose status is `SUCCEEDED` or `FAILED` (PR-JOB-003, AGENTS rule 6), and never UPDATE or delete a `JobAttempt` or `WebhookDelivery` row once created (CS-6). There is no correction mechanism for these in the PRD; if one is ever needed, flag it rather than writing an UPDATE.

**DB-7 No cascading deletes on `Account`-rooted relations.** Every relation from `Account` (`ApiKey`, `Job`, `WebhookEndpoint`) uses `onDelete: Restrict` in the locked schema. Never change this to `Cascade` or `SetNull`. Account deletion has no defined semantics in the PRD (Open Question 10) — do not build it; an attempt to delete an account with any history must fail, which `Restrict` already guarantees.

**DB-8 "Concurrent non-terminal" has exactly one definition.** PR-ABUSE-001's cap counts jobs where `status` is `QUEUED` or `PROCESSING`. Implement this once, in `/modules/abuse`, and use that single function everywhere the count is needed (the API's pre-submission check, the dashboard, any future admin view). Never redefine "non-terminal" locally at a second call site.

**DB-9 Raw SQL.** `$queryRaw` tagged templates only, with parameters. Never `$queryRawUnsafe` or `$executeRawUnsafe`; never string-built SQL.

**DB-10 Seeds and scripts respect the gates.** No seed or script outside `/tests` creates a `Job` directly in `SUCCEEDED` or `FAILED` without a corresponding `JobAttempt` row, and none bypasses the `(accountId, idempotencyKey)` unique constraint. Test fixtures may, in test databases only. Seeds use synthetic data only — no real API keys, emails, or payloads.

**DB-11 Any billing-model schema change needs its own approval.** Adding `Subscription`, `amount`, `currency`, or any payment-related model is gated by AGENTS rule 21 (the billing phase gate) on top of DB-1 — both must clear before the migration is written, not just the schema-lock check.