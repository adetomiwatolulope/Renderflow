---
name: prisma-schema-and-migration-discipline
description: Any change to schema.prisma, or a new query pattern against an existing model. Load before generating a migration.
---

## What this teaches
How to extend the locked schema safely and verify a new query is actually covered by an index, without breaking an existing constraint.

## Ordered steps
1. **Confirm this is additive, not destructive** (DB-1). No rename, removal, or type change of any existing model/enum/field. A destructive change requires an explicit instruction naming it.
2. **If this introduces a new enum value** for `JobType`, `JobStatus`, `AttemptOutcome`, or `WebhookDeliveryStatus` — stop. That's a new business state (DB-2); flag it per AGENTS Q7 rather than adding it.
3. **Check whether an existing index already covers the new query** before assuming you need one — the schema anticipates: claiming (`[status, nextAttemptAt]`), stall detection (`[status, lastHeartbeatAt]`), concurrent-cap (`[accountId, status]`), daily-cap (`[accountId, createdAt]`), auth lookup (`[hashedKey]`). If none fits, add the matching index **in the same migration** (DB-4).
4. **If this adds a money field**, it is a whole integer in the smallest currency unit — never `Float`/`Decimal` — and confirm Prisma `Int`'s 32-bit range actually holds for the currency in question (DB-5). This currently has no live target (no billing model exists) but the rule applies the moment one is added.
5. **If this touches an `Account`-rooted relation**, confirm `onDelete: Restrict` is preserved — never `Cascade`/`SetNull` (DB-7). Account deletion has no defined semantics (Open Question 10); don't build around that gap, preserve the restriction.
6. **Write the migration as a committed file.** Never `prisma db push` or `migrate reset` outside a disposable local database. Read the generated SQL — any `DROP` or lossy `ALTER` stops the task (DB-3).
7. **If this is a billing-related model** (`Subscription`, `amount`, `currency`), this needs its own explicit approval on top of the schema-lock check — see flutterwave-payment-integration (DB-11, MB-4).
8. **Never edit a migration that's already applied or merged** — a fix is a new migration, always.

## Must never
- Update or delete a `Job` whose status is `SUCCEEDED`/`FAILED`, or any `JobAttempt`/`WebhookDelivery` row once created (DB-6).
- Use `$queryRawUnsafe`/`$executeRawUnsafe` or string-built SQL (DB-9).
- Seed a `Job` directly into a terminal status without a corresponding `JobAttempt`, or bypass the `(accountId, idempotencyKey)` constraint outside test fixtures (DB-10).