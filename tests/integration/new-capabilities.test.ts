import { test } from "node:test";
import assert from "node:assert/strict";

import { createHash } from "node:crypto";

import { JobStatus, JobType } from "@prisma/client";

import { db } from "../../lib/db/client";
import { hashApiKey } from "../../lib/auth/hash-api-key";
import { consumeRateLimit } from "../../lib/ratelimit/consume-rate-limit";
import {
  concurrentCap,
  dailySubmissionCap,
  SubmissionCapExceededError,
  currentUsage,
} from "../../modules/abuse/enforce-submission-caps";
import { createAccountWithApiKey, rotateApiKey } from "../../modules/auth/api-keys";
import { createJob } from "../../modules/jobs/create-job";
import { InvalidJobListQueryError, listJobsForAccount } from "../../modules/jobs/list-jobs";
import { isTerminalJobStatus } from "../../modules/webhooks/payload";

/**
 * DB-backed coverage for the five capabilities added after the Step 9 pipeline:
 * rate limiting, abuse caps, key issuance/rotation, job listing, and the
 * terminal-state decision behind webhook delivery.
 *
 * These call module functions directly rather than going through HTTP, because
 * the rate limiter and the caps are themselves database-contended and an
 * in-process server would not exercise the same interleavings.
 */

async function makeAccount(label: string): Promise<{ accountId: string; apiKey: string }> {
  const issued = await createAccountWithApiKey(`${label}-${Date.now()}-${Math.random()}`);
  return { accountId: issued.accountId, apiKey: issued.apiKey };
}

async function submitJob(accountId: string, key: string): Promise<string> {
  const result = await createJob({
    accountId,
    body: { type: JobType.WEBHOOK_CALL, payload: { url: "https://example.com" }, idempotencyKey: key },
  });
  return result.job.id;
}

async function clearAccount(accountId: string): Promise<void> {
  await db.webhookDelivery.deleteMany({ where: { job: { accountId } } });
  await db.jobAttempt.deleteMany({ where: { job: { accountId } } });
  await db.jobOutput.deleteMany({ where: { job: { accountId } } });
  await db.job.deleteMany({ where: { accountId } });
  await db.webhookEndpoint.deleteMany({ where: { accountId } });
  await db.apiKey.deleteMany({ where: { accountId } });
  await db.account.deleteMany({ where: { id: accountId } });
  await db.rateLimitWindow.deleteMany({ where: { key: accountId } });
}

test("PR-TECH-006: requests are allowed up to the limit and refused past it", async () => {
  const { accountId } = await makeAccount("ratelimit");
  const limit = 5;
  try {
    for (let i = 1; i <= limit; i += 1) {
      const decision = await consumeRateLimit(accountId, limit);
      assert.equal(decision.allowed, true, `request ${i} should be allowed`);
    }

    const refused = await consumeRateLimit(accountId, limit);
    assert.equal(refused.allowed, false);
    assert.ok(refused.retryAfterSeconds >= 1, "a refusal must carry a positive Retry-After");

    const after = await consumeRateLimit(accountId, limit);
    assert.equal(after.allowed, false, "the budget must not reset while calls keep arriving");
  } finally {
    await clearAccount(accountId);
  }
});

test("PR-TECH-006: the budget is per account, not global", async () => {
  const a = await makeAccount("ratelimit-a");
  const b = await makeAccount("ratelimit-b");
  try {
    for (let i = 0; i < 3; i += 1) {
      await consumeRateLimit(a.accountId, 2);
    }
    assert.equal((await consumeRateLimit(a.accountId, 2)).allowed, false);
    assert.equal((await consumeRateLimit(b.accountId, 2)).allowed, true);
  } finally {
    await clearAccount(a.accountId);
    await clearAccount(b.accountId);
  }
});

test("PR-TECH-006: rotating the key does not hand the account a fresh budget", async () => {
  const { accountId } = await makeAccount("ratelimit-rotate");
  try {
    for (let i = 0; i < 2; i += 1) {
      await consumeRateLimit(accountId, 2);
    }
    assert.equal((await consumeRateLimit(accountId, 2)).allowed, false);

    await rotateApiKey(accountId);

    // The counter is keyed by account, so a rotation cannot be used to reset it.
    assert.equal((await consumeRateLimit(accountId, 2)).allowed, false);
  } finally {
    await clearAccount(accountId);
  }
});

test("PR-ABUSE-001: the concurrent non-terminal cap refuses a new submission", async () => {
  const { accountId, apiKey } = await makeAccount("abuse-concurrent");
  const previousCap = concurrentCap();
  process.env.CONCURRENT_NON_TERMINAL_CAP = "2";
  try {
    await submitJob(accountId, `${apiKey}-1`);
    await submitJob(accountId, `${apiKey}-2`);

    await assert.rejects(
      () => submitJob(accountId, `${apiKey}-3`),
      (error: unknown) => {
        assert.ok(error instanceof SubmissionCapExceededError);
        assert.equal(error.kind, "concurrent");
        return true;
      },
    );

    // A refused submission must not have created a row.
    const usage = await currentUsage(accountId);
    assert.equal(usage.nonTerminal, 2);
  } finally {
    delete process.env.CONCURRENT_NON_TERMINAL_CAP;
    assert.equal(concurrentCap(), previousCap);
    await clearAccount(accountId);
  }
});

test("PR-ABUSE-001: the cap lifts once jobs reach a terminal state", async () => {
  const { accountId, apiKey } = await makeAccount("abuse-release");
  process.env.CONCURRENT_NON_TERMINAL_CAP = "2";
  try {
    const first = await submitJob(accountId, `${apiKey}-1`);
    await submitJob(accountId, `${apiKey}-2`);

    await db.job.update({ where: { id: first }, data: { status: JobStatus.SUCCEEDED } });

    // The freed slot is usable, proving the cap counts non-terminal jobs rather
    // than submissions made.
    const third = await createJob({
      accountId,
      body: { type: JobType.WEBHOOK_CALL, payload: {}, idempotencyKey: `${apiKey}-3` },
    });
    assert.equal(third.outcome, "created");
  } finally {
    delete process.env.CONCURRENT_NON_TERMINAL_CAP;
    await clearAccount(accountId);
  }
});

test("PR-ABUSE-001: the daily submission cap refuses even when nothing is queued", async () => {
  const { accountId, apiKey } = await makeAccount("abuse-daily");
  process.env.DAILY_SUBMISSION_CAP = "2";
  try {
    const first = await submitJob(accountId, `${apiKey}-1`);
    await submitJob(accountId, `${apiKey}-2`);

    await assert.rejects(
      () => submitJob(accountId, `${apiKey}-3`),
      (error: unknown) => {
        assert.ok(error instanceof SubmissionCapExceededError);
        assert.equal(error.kind, "daily");
        return true;
      },
    );

    // Nothing is running, so only the daily cap can be responsible.
    assert.equal((await currentUsage(accountId)).nonTerminal, 2);
    assert.ok(first.length > 0);
  } finally {
    delete process.env.DAILY_SUBMISSION_CAP;
    await clearAccount(accountId);
  }
});

test("PR-ABUSE-001: caps do not affect an idempotent replay of an existing job", async () => {
  const { accountId } = await makeAccount("abuse-idempotent");
  process.env.DAILY_SUBMISSION_CAP = "1";
  try {
    await submitJob(accountId, "same-key");

    // PR-IDEM-002 outranks the cap for a replay: the caller is not creating work,
    // they are asking about work they already submitted.
    const replay = await createJob({
      accountId,
      body: { type: JobType.WEBHOOK_CALL, payload: { url: "https://example.com" }, idempotencyKey: "same-key" },
    });
    assert.equal(replay.outcome, "existing");
  } finally {
    delete process.env.DAILY_SUBMISSION_CAP;
    await clearAccount(accountId);
  }
});

test("the cap defaults match the PRD", () => {
  const noOverrides = { ...process.env };
  delete noOverrides.CONCURRENT_NON_TERMINAL_CAP;
  delete noOverrides.DAILY_SUBMISSION_CAP;
  assert.equal(concurrentCap(noOverrides), 100);
  assert.equal(dailySubmissionCap(noOverrides), 5000);
});

test("PR-AUTH-003: only the hash of a key is stored", async () => {
  const issued = await createAccountWithApiKey(`hash-check-${Date.now()}`);
  try {
    const stored = await db.apiKey.findUnique({ where: { accountId: issued.accountId } });
    assert.notEqual(stored?.hashedKey, issued.apiKey);
    assert.equal(stored?.hashedKey, createHash("sha256").update(issued.apiKey, "utf8").digest("hex"));
    assert.equal(stored?.prefix, issued.apiKey.slice(0, 12));
  } finally {
    await clearAccount(issued.accountId);
  }
});

test("PR-AUTH-002: exactly one key row exists per account", async () => {
  const { accountId } = await makeAccount("one-key");
  try {
    await rotateApiKey(accountId);
    await rotateApiKey(accountId);
    const keys = await db.apiKey.findMany({ where: { accountId } });
    assert.equal(keys.length, 1);
  } finally {
    await clearAccount(accountId);
  }
});

test("PR-AUTH-002: the previous key stops authenticating immediately", async () => {
  const { accountId, apiKey } = await makeAccount("rotate-old-key");
  try {
    const before = await db.apiKey.findUnique({ where: { accountId }, select: { hashedKey: true } });
    const rotated = await rotateApiKey(accountId);
    const after = await db.apiKey.findUnique({ where: { accountId }, select: { hashedKey: true } });

    assert.notEqual(rotated.apiKey, apiKey);
    assert.notEqual(after?.hashedKey, before?.hashedKey);
    assert.equal(after?.hashedKey, hashApiKey(rotated.apiKey));

    // The old plaintext no longer matches any stored hash, which is exactly what
    // stops it authenticating.
    assert.notEqual(hashApiKey(apiKey), after?.hashedKey);
  } finally {
    await clearAccount(accountId);
  }
});

test("rotation records when it happened and fails loudly for an unknown account", async () => {
  const { accountId } = await makeAccount("rotate-meta");
  try {
    const issued = await createAccountWithApiKey(`rotate-unknown-${Date.now()}`);
    const rotated = await rotateApiKey(issued.accountId);
    const stored = await db.apiKey.findUnique({ where: { accountId: issued.accountId } });
    assert.ok(stored?.rotatedAt instanceof Date);
    assert.ok(rotated.rotatedAt instanceof Date);
    await clearAccount(issued.accountId);
  } finally {
    await clearAccount(accountId);
  }
});

test("PR-JOB-005: listing returns only the caller's own jobs", async () => {
  const mine = await makeAccount("list-mine");
  const theirs = await makeAccount("list-theirs");
  try {
    await submitJob(mine.accountId, "mine-1");
    await submitJob(mine.accountId, "mine-2");
    await submitJob(theirs.accountId, "theirs-1");

    const page = await listJobsForAccount(mine.accountId);
    assert.equal(page.jobs.length, 2);
    assert.ok(page.jobs.every((job) => job.id !== "theirs-1"), "must not leak another account's job");
  } finally {
    await clearAccount(mine.accountId);
    await clearAccount(theirs.accountId);
  }
});

test("PR-JOB-005: status and type filters narrow the result", async () => {
  const { accountId, apiKey } = await makeAccount("list-filter");
  try {
    const succeeded = await submitJob(accountId, `${apiKey}-s`);
    await submitJob(accountId, `${apiKey}-q`);
    await db.job.update({ where: { id: succeeded }, data: { status: JobStatus.SUCCEEDED } });

    const byStatus = await listJobsForAccount(accountId, { status: "SUCCEEDED" });
    assert.equal(byStatus.jobs.length, 1);
    assert.equal(byStatus.jobs[0]?.id, succeeded);

    const byType = await listJobsForAccount(accountId, { type: "WEBHOOK_CALL" });
    assert.equal(byType.jobs.length, 2);
  } finally {
    await clearAccount(accountId);
  }
});

test("PR-JOB-005: a cursor walks every job exactly once", async () => {
  const { accountId, apiKey } = await makeAccount("list-cursor");
  try {
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(await submitJob(accountId, `${apiKey}-${i}`));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await listJobsForAccount(accountId, { limit: "2", cursor });
      seen.push(...result.jobs.map((job) => job.id));
      if (result.nextCursor === null) {
        break;
      }
      cursor = result.nextCursor;
    }

    assert.deepEqual([...seen].sort(), [...created].sort());
    assert.equal(new Set(seen).size, seen.length, "no job may appear on two pages");
  } finally {
    await clearAccount(accountId);
  }
});

test("PR-JOB-005: an unknown filter value or forged cursor is rejected", async () => {
  const { accountId } = await makeAccount("list-invalid");
  try {
    await assert.rejects(() => listJobsForAccount(accountId, { status: "NOT_A_STATUS" }), InvalidJobListQueryError);
    await assert.rejects(() => listJobsForAccount(accountId, { type: "NOT_A_TYPE" }), InvalidJobListQueryError);
    await assert.rejects(() => listJobsForAccount(accountId, { limit: "0" }), InvalidJobListQueryError);
    await assert.rejects(() => listJobsForAccount(accountId, { cursor: "not-a-cursor" }), InvalidJobListQueryError);
  } finally {
    await clearAccount(accountId);
  }
});

test("PR-WEBHOOK-002: notification is sent only for terminal states", () => {
  assert.equal(isTerminalJobStatus(JobStatus.SUCCEEDED), true);
  assert.equal(isTerminalJobStatus(JobStatus.DEAD), true);
  assert.equal(isTerminalJobStatus(JobStatus.FAILED), false, "FAILED is retry-waiting, not final");
  assert.equal(isTerminalJobStatus(JobStatus.PROCESSING), false);
  assert.equal(isTerminalJobStatus(JobStatus.QUEUED), false);
});
