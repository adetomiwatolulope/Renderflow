import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { db } from "../../lib/db/client";
import { hashApiKey } from "../../lib/auth/hash-api-key";
import { createJob } from "../../modules/jobs/create-job";
import { IdempotencyConflictError } from "../../modules/jobs/errors";

/**
 * Step 2's proof: submitting the same idempotency key twice yields one job.
 * Requires a reachable PostgreSQL (PR-TECH-001 is Postgres-only).
 */

const createdAccountIds: string[] = [];

async function createAccountWithKey(): Promise<{ accountId: string; rawKey: string }> {
  const rawKey = `rf_test_${randomUUID()}`;
  const account = await db.account.create({
    data: {
      name: `test-${randomUUID()}`,
      apiKey: { create: { hashedKey: hashApiKey(rawKey), prefix: rawKey.slice(0, 11) } },
    },
    select: { id: true },
  });
  createdAccountIds.push(account.id);
  return { accountId: account.id, rawKey };
}

before(async () => {
  await db.$connect();
});

after(async () => {
  // Job rows restrict deletion while their attempts exist, so remove children first.
  await db.jobAttempt.deleteMany({});
  await db.job.deleteMany({});
  await db.apiKey.deleteMany({});
  await db.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  await db.$disconnect();
});

test("a new submission is created as QUEUED with maxAttempts from config", async () => {
  const { accountId } = await createAccountWithKey();

  const result = await createJob({
    accountId,
    body: { type: "CUSTOM", payload: { hello: "world" }, idempotencyKey: "create-1" },
  });

  assert.equal(result.outcome, "created");
  assert.equal(result.job.status, "QUEUED");
  assert.equal(result.job.attempts, 0);
  assert.equal(result.job.maxAttempts, 5);
  assert.equal(result.job.runAt, null);
});

test("the same key submitted twice returns the existing job, not a second one", async () => {
  const { accountId } = await createAccountWithKey();
  const body = { type: "CUSTOM", payload: { hello: "world" }, idempotencyKey: "double-1" };

  const first = await createJob({ accountId, body });
  const second = await createJob({ accountId, body });

  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "existing");
  assert.equal(second.job.id, first.job.id);

  const rows = await db.job.count({ where: { accountId, idempotencyKey: "double-1" } });
  assert.equal(rows, 1);
});

test("key order in the payload does not cause a false conflict", async () => {
  const { accountId } = await createAccountWithKey();

  const first = await createJob({
    accountId,
    body: { type: "CUSTOM", payload: { a: 1, b: 2 }, idempotencyKey: "order-1" },
  });
  const second = await createJob({
    accountId,
    body: { type: "CUSTOM", payload: { b: 2, a: 1 }, idempotencyKey: "order-1" },
  });

  assert.equal(second.outcome, "existing");
  assert.equal(second.job.id, first.job.id);
});

// AGENTS rule 13 / PR-IDEM-002: mismatched payload is refused, nothing created.
test("the same key with a different payload is refused with a conflict", async () => {
  const { accountId } = await createAccountWithKey();

  await createJob({
    accountId,
    body: { type: "CUSTOM", payload: { a: 1 }, idempotencyKey: "mismatch-1" },
  });

  await assert.rejects(
    () =>
      createJob({
        accountId,
        body: { type: "CUSTOM", payload: { a: 2 }, idempotencyKey: "mismatch-1" },
      }),
    IdempotencyConflictError,
  );

  const rows = await db.job.count({ where: { accountId, idempotencyKey: "mismatch-1" } });
  assert.equal(rows, 1);
});

// CS-14: the guard must hold under a race, not just sequentially.
test("concurrent submissions of one key create exactly one job", async () => {
  const { accountId } = await createAccountWithKey();
  const body = { type: "CUSTOM", payload: { race: true }, idempotencyKey: "race-1" };

  const outcomes = await Promise.allSettled(
    Array.from({ length: 5 }, () => createJob({ accountId, body })),
  );

  const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
  const created = fulfilled.filter((o) => o.status === "fulfilled" && o.value.outcome === "created");
  const existing = fulfilled.filter((o) => o.status === "fulfilled" && o.value.outcome === "existing");

  assert.equal(created.length + existing.length, 5);
  assert.equal(created.length, 1);
  assert.equal(existing.length, 4);

  const ids = new Set(
    fulfilled.map((o) => (o.status === "fulfilled" ? o.value.job.id : "unreachable")),
  );
  assert.equal(ids.size, 1);

  const rows = await db.job.count({ where: { accountId, idempotencyKey: "race-1" } });
  assert.equal(rows, 1);
});

// PR-IDEM-001: the key is unique per account, not globally.
test("two accounts may use the same idempotency key for different jobs", async () => {
  const first = await createAccountWithKey();
  const second = await createAccountWithKey();
  const body = { type: "CUSTOM", payload: { shared: true }, idempotencyKey: "shared-key" };

  const a = await createJob({ accountId: first.accountId, body });
  const b = await createJob({ accountId: second.accountId, body });

  assert.equal(a.outcome, "created");
  assert.equal(b.outcome, "created");
  assert.notEqual(a.job.id, b.job.id);
});
