import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { POST } from "../../app/api/v1/jobs/route";
import { db } from "../../lib/db/client";
import { createAccountWithApiKey } from "../../modules/auth/api-keys";
import { MAX_PAYLOAD_BYTES } from "../../modules/jobs/validate-create-job";

/**
 * Step 2 at the HTTP boundary: `POST /api/v1/jobs` is proved by calling the real
 * route handler, so the status codes a caller actually sees are asserted rather
 * than inferred from a module function's return value.
 *
 * The other integration tests deliberately call module functions directly,
 * because the rate limiter and the caps are database-contended and an in-process
 * handler would not exercise the same interleavings. That is the right trade for
 * *behaviour*; it left the request/response contract itself unasserted, which is
 * what this file covers. No server is started - the handler takes a `Request` and
 * returns a `Response`, which is enough to prove the mapping.
 *
 * Requires a reachable PostgreSQL.
 */

const ENDPOINT = "http://localhost:3001/api/v1/jobs";
const MAX_REQUEST_BYTES = 300 * 1024;

const createdAccountIds: string[] = [];

async function makeAccount(label: string): Promise<{ accountId: string; apiKey: string }> {
  const issued = await createAccountWithApiKey(`${label}-${randomUUID()}`);
  createdAccountIds.push(issued.accountId);
  return { accountId: issued.accountId, apiKey: issued.apiKey };
}

type Body = Record<string, unknown>;

function post(
  apiKey: string | null,
  body: Body | string,
  headers: Record<string, string> = {},
): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Problem = { error: { code: string; message: string; fieldErrors?: Record<string, string> } };

async function problemOf(response: Response): Promise<Problem> {
  return (await response.json()) as Problem;
}

async function submit(
  apiKey: string,
  idempotencyKey: string,
  payload: Body = { hello: "world" },
): Promise<Response> {
  return POST(post(apiKey, { type: "CUSTOM", payload, idempotencyKey }));
}

before(async () => {
  await db.$connect();
});

after(async () => {
  // Children first: job rows restrict deletion while attempts and outputs exist.
  await db.jobAttempt.deleteMany({});
  await db.webhookDelivery.deleteMany({});
  await db.jobOutput.deleteMany({});
  await db.job.deleteMany({});
  await db.webhookEndpoint.deleteMany({});
  await db.apiKey.deleteMany({});
  await db.rateLimitWindow.deleteMany({ where: { key: { in: createdAccountIds } } });
  await db.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  await db.$disconnect();
});

// PR-JOB-002: accepted for asynchronous processing, not completed.
test("a new submission is accepted with 202 and a queued job id", async () => {
  const { accountId, apiKey } = await makeAccount("enqueue-202");

  const response = await submit(apiKey, "enqueue-202-1");
  assert.equal(response.status, 202);

  const body = (await response.json()) as { id: string; status: string; attempts: number; runAt: null };
  assert.equal(typeof body.id, "string");
  assert.ok(body.id.length > 0, "the caller must be handed a job id");
  assert.equal(body.status, "QUEUED");
  assert.equal(body.attempts, 0);
  assert.equal(body.runAt, null, "a new job is immediately claimable");

  const rows = await db.job.count({ where: { accountId, idempotencyKey: "enqueue-202-1" } });
  assert.equal(rows, 1);
});

// The handler does no work and does not wait: nothing advanced the job past QUEUED.
test("the handler returns before any attempt has run", async () => {
  const { accountId, apiKey } = await makeAccount("enqueue-no-work");

  const response = await submit(apiKey, "enqueue-no-work-1");
  const body = (await response.json()) as { id: string };

  const row = await db.job.findUniqueOrThrow({ where: { id: body.id } });
  assert.equal(row.status, "QUEUED");
  assert.equal(row.attempts, 0);
  assert.equal(row.startedAt, null, "no claim may have happened");
  assert.equal(row.lastError, null);
  assert.equal(await db.jobAttempt.count({ where: { jobId: row.id } }), 0);
  assert.equal(row.accountId, accountId);
});

// PR-IDEM-002: a replay is the existing job, and it is not a fresh acceptance.
test("replaying an idempotency key returns the same job with 200", async () => {
  const { accountId, apiKey } = await makeAccount("enqueue-replay");

  const first = await submit(apiKey, "enqueue-replay-1");
  const second = await submit(apiKey, "enqueue-replay-1");

  assert.equal(first.status, 202);
  assert.equal(second.status, 200);

  const firstBody = (await first.json()) as { id: string };
  const secondBody = (await second.json()) as { id: string; status: string };
  assert.equal(secondBody.id, firstBody.id, "a replay must not mint a second job");
  assert.equal(secondBody.status, "QUEUED");

  assert.equal(await db.job.count({ where: { accountId, idempotencyKey: "enqueue-replay-1" } }), 1);
});

// PR-IDEM-002: the replay reflects the job's real state, not a fresh QUEUED.
test("a replay reports the job's current status rather than resetting it", async () => {
  const { apiKey } = await makeAccount("enqueue-replay-state");

  const first = await submit(apiKey, "enqueue-replay-state-1");
  const created = (await first.json()) as { id: string };
  await db.job.update({
    where: { id: created.id },
    data: { status: "SUCCEEDED", attempts: 1, finishedAt: new Date() },
  });

  const replay = await submit(apiKey, "enqueue-replay-state-1");
  assert.equal(replay.status, 200);
  const body = (await replay.json()) as { id: string; status: string; attempts: number };
  assert.equal(body.id, created.id);
  assert.equal(body.status, "SUCCEEDED");
  assert.equal(body.attempts, 1);
});

// PR-IDEM-002 / AGENTS rule 13: mismatched payload is refused, nothing created.
test("a reused key with a different payload is refused with 409", async () => {
  const { accountId, apiKey } = await makeAccount("enqueue-conflict");

  await submit(apiKey, "enqueue-conflict-1", { a: 1 });

  const conflict = await submit(apiKey, "enqueue-conflict-1", { a: 2 });
  assert.equal(conflict.status, 409);

  const problem = await problemOf(conflict);
  assert.equal(problem.error.code, "idempotency_conflict");

  assert.equal(await db.job.count({ where: { accountId, idempotencyKey: "enqueue-conflict-1" } }), 1);
});

// Key order is not a payload change, so it must not read as a conflict.
test("a replay whose payload has different key order still returns 200", async () => {
  const { apiKey } = await makeAccount("enqueue-reorder");

  const first = await POST(post(apiKey, { type: "CUSTOM", payload: { a: 1, b: 2 }, idempotencyKey: "enqueue-reorder-1" }));
  const created = (await first.json()) as { id: string };

  const replay = await POST(post(apiKey, { type: "CUSTOM", payload: { b: 2, a: 1 }, idempotencyKey: "enqueue-reorder-1" }));
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { id: string }).id, created.id);
});

test("a submission with no API key is refused with 401", async () => {
  const response = await POST(post(null, { type: "CUSTOM", payload: {}, idempotencyKey: "no-key" }));
  assert.equal(response.status, 401);
  assert.equal((await problemOf(response)).error.code, "unauthorized");
});

// PR-AUTH-001: a missing key and an unknown key must be indistinguishable, or the
// endpoint becomes a probe for which keys exist.
test("an unknown API key is refused exactly like a missing one", async () => {
  const { apiKey } = await makeAccount("enqueue-probe");

  const missing = await POST(post(null, { type: "CUSTOM", payload: {}, idempotencyKey: "probe" }));
  const unknown = await POST(
    post(`rf_not_a_real_key_${randomUUID()}`, { type: "CUSTOM", payload: {}, idempotencyKey: "probe" }),
  );

  assert.equal(missing.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await unknown.json(), await missing.json());

  const rows = await db.job.count({ where: { idempotencyKey: "probe" } });
  assert.equal(rows, 0, "an unauthenticated call must not create a job");

  assert.equal(typeof apiKey, "string");
});

// CS-12: a rejection names the offending fields.
test("a submission that fails validation is refused with 422 and field errors", async () => {
  const { apiKey } = await makeAccount("enqueue-422");

  const response = await POST(post(apiKey, { type: "NOT_A_TYPE", payload: {} }));
  assert.equal(response.status, 422);

  const problem = await problemOf(response);
  assert.equal(problem.error.code, "invalid_submission");
  assert.ok("type" in (problem.error.fieldErrors ?? {}));
  assert.ok("idempotencyKey" in (problem.error.fieldErrors ?? {}));
});

test("a body that is not JSON is refused with 400", async () => {
  const { apiKey } = await makeAccount("enqueue-400");

  const response = await POST(post(apiKey, "{not json"));
  assert.equal(response.status, 400);
  assert.equal((await problemOf(response)).error.code, "invalid_json");
});

// PR-JOB-008: over the cap, refused with 413, and no row created.
test("a payload over 256KB is refused with 413 before any row is created", async () => {
  const { accountId, apiKey } = await makeAccount("enqueue-413-payload");

  const oversized = { blob: "x".repeat(MAX_PAYLOAD_BYTES + 1) };
  const response = await POST(post(apiKey, { type: "CUSTOM", payload: oversized, idempotencyKey: "too-big-payload" }));

  assert.equal(response.status, 413);
  assert.equal((await problemOf(response)).error.code, "payload_too_large");
  assert.equal(await db.job.count({ where: { accountId } }), 0);
});

// The request-level cap is separate and larger: it is the cheap guard against a
// body too big to buffer at all, and it fires before authentication.
test("a request body over 300KB is refused with 413 before authentication", async () => {
  const { accountId, apiKey } = await makeAccount("enqueue-413-body");

  const body = JSON.stringify({
    type: "CUSTOM",
    payload: { blob: "x".repeat(MAX_REQUEST_BYTES + 1) },
    idempotencyKey: "too-big-body",
  });
  const response = await POST(post(apiKey, body));

  assert.equal(response.status, 413);
  assert.equal(await db.job.count({ where: { accountId } }), 0);
});

// PR-TECH-006: a throttled caller is refused, and told when to come back.
test("a caller over the request budget is refused with 429 and a Retry-After", async () => {
  const { accountId, apiKey } = await makeAccount("enqueue-429-rate");
  const previous = process.env.RATE_LIMIT_PER_MINUTE;
  process.env.RATE_LIMIT_PER_MINUTE = "1";
  try {
    assert.equal((await submit(apiKey, "rate-1")).status, 202);

    const throttled = await submit(apiKey, "rate-2");
    assert.equal(throttled.status, 429);
    assert.equal((await problemOf(throttled)).error.code, "rate_limit_exceeded");
    assert.ok(Number(throttled.headers.get("Retry-After")) >= 1, "a refusal must carry a positive Retry-After");

    assert.equal(await db.job.count({ where: { accountId } }), 1, "the throttled submission must not be created");
  } finally {
    if (previous === undefined) {
      delete process.env.RATE_LIMIT_PER_MINUTE;
    } else {
      process.env.RATE_LIMIT_PER_MINUTE = previous;
    }
  }
});

// PR-ABUSE-001: the cap refuses a new submission, and names which cap refused it.
test("an account at its concurrent cap is refused with 429", async () => {
  const { accountId, apiKey } = await makeAccount("enqueue-429-cap");
  const previous = process.env.CONCURRENT_NON_TERMINAL_CAP;
  process.env.CONCURRENT_NON_TERMINAL_CAP = "1";
  try {
    assert.equal((await submit(apiKey, "cap-1")).status, 202);

    const capped = await submit(apiKey, "cap-2");
    assert.equal(capped.status, 429);
    assert.equal((await problemOf(capped)).error.code, "too_many_concurrent_jobs");
    assert.equal(await db.job.count({ where: { accountId } }), 1);
  } finally {
    if (previous === undefined) {
      delete process.env.CONCURRENT_NON_TERMINAL_CAP;
    } else {
      process.env.CONCURRENT_NON_TERMINAL_CAP = previous;
    }
  }
});

// PR-IDEM-002 outranks the cap for a replay, at the HTTP layer too.
test("a replay is not refused by a cap the account is already at", async () => {
  const { apiKey } = await makeAccount("enqueue-replay-cap");
  const previous = process.env.CONCURRENT_NON_TERMINAL_CAP;
  process.env.CONCURRENT_NON_TERMINAL_CAP = "1";
  try {
    const first = await submit(apiKey, "replay-cap-1");
    const created = (await first.json()) as { id: string };

    const replay = await submit(apiKey, "replay-cap-1");
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as { id: string }).id, created.id);
  } finally {
    if (previous === undefined) {
      delete process.env.CONCURRENT_NON_TERMINAL_CAP;
    } else {
      process.env.CONCURRENT_NON_TERMINAL_CAP = previous;
    }
  }
});

// AGENTS rule 2: a job belongs to the account whose key created it, and the
// response must not hand one account anything about another's job.
test("two accounts sharing an idempotency key each get their own job", async () => {
  const first = await makeAccount("enqueue-scope-a");
  const second = await makeAccount("enqueue-scope-b");

  const a = await submit(first.apiKey, "shared-key");
  const b = await submit(second.apiKey, "shared-key");

  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  const idA = ((await a.json()) as { id: string }).id;
  const idB = ((await b.json()) as { id: string }).id;
  assert.notEqual(idA, idB);

  assert.equal((await db.job.findUniqueOrThrow({ where: { id: idA } })).accountId, first.accountId);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: idB } })).accountId, second.accountId);
});

// SEC-6: the response is built from an allowlist, so a column added to the table
// later cannot start leaking by default.
test("the response exposes no server-owned field", async () => {
  const { apiKey } = await makeAccount("enqueue-allowlist");

  const body = (await (await submit(apiKey, "allowlist-1")).json()) as Record<string, unknown>;
  for (const leaked of ["accountId", "idempotencyKey", "lastHeartbeatAt", "updatedAt"]) {
    assert.equal(leaked in body, false, `${leaked} must not be exposed`);
  }
  for (const expected of ["id", "type", "status", "payload", "attempts", "maxAttempts"]) {
    assert.ok(expected in body, `${expected} should be exposed`);
  }
});
