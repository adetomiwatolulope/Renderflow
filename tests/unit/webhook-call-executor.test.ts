import assert from "node:assert/strict";
import { test } from "node:test";

import type { Prisma } from "@prisma/client";

import type { ClaimedJob } from "../../modules/queue/claim";
import {
  buildRequest,
  classifyStatusCode,
  executeWebhookCall,
} from "../../worker/executors/webhook-call";

function claimedJob(payload: Prisma.JsonValue, jobId = "job_1"): ClaimedJob {
  return {
    id: jobId,
    accountId: "acct_1",
    type: "WEBHOOK_CALL",
    payload,
    attempts: 1,
    maxAttempts: 5,
    startedAt: new Date("2026-09-27T12:00:00.000Z"),
  };
}

async function expectFailure(payload: Prisma.JsonValue, errorCode: string) {
  const result = await executeWebhookCall(claimedJob(payload));
  assert.equal(result.kind, "failure");
  assert.ok(result.kind === "failure");
  assert.equal(result.errorCode, errorCode);
  assert.equal(result.retryable, false);
}

// Owner's Step 5: the work must be safe to run twice, keyed on the job id.
test("every request carries the job id as an idempotency key", () => {
  const built = buildRequest(claimedJob({ url: "https://example.com/hook" }, "job_abc"));
  assert.equal(built.ok, true);
  assert.ok(built.ok);
  const headers = built.init.headers as Record<string, string>;
  assert.equal(headers["Idempotency-Key"], "job_abc");
});

test("the idempotency key is stable across attempts of the same job", () => {
  // A crashed worker's retry is a repeat of the same logical work, so the key
  // must not vary with the attempt number.
  const first = claimedJob({ url: "https://example.com/hook" }, "job_stable");
  const retry = { ...first, attempts: 4 };

  const a = buildRequest(first);
  const b = buildRequest(retry);
  assert.ok(a.ok && b.ok);
  assert.equal(
    (a.init.headers as Record<string, string>)["Idempotency-Key"],
    (b.init.headers as Record<string, string>)["Idempotency-Key"],
  );
});

test("two different jobs send different idempotency keys", () => {
  const a = buildRequest(claimedJob({ url: "https://example.com/hook" }, "job_one"));
  const b = buildRequest(claimedJob({ url: "https://example.com/hook" }, "job_two"));
  assert.ok(a.ok && b.ok);
  assert.notEqual(
    (a.init.headers as Record<string, string>)["Idempotency-Key"],
    (b.init.headers as Record<string, string>)["Idempotency-Key"],
  );
});

test("a caller cannot override the idempotency key", () => {
  const built = buildRequest(
    claimedJob({
      url: "https://example.com/hook",
      headers: { "Idempotency-Key": "caller-supplied" },
    }),
  );
  assert.equal(built.ok, false);
  assert.ok(!built.ok);
  assert.equal(built.errorCode, "RESERVED_HEADER");
});

test("a caller cannot override the idempotency key by odd casing", () => {
  const built = buildRequest(
    claimedJob({
      url: "https://example.com/hook",
      headers: { "idempotency-key": "caller-supplied" },
    }),
  );
  assert.equal(built.ok, false);
  assert.ok(!built.ok);
  assert.equal(built.errorCode, "RESERVED_HEADER");
});

test("the idempotency key is sent alongside a JSON body", () => {
  const built = buildRequest(
    claimedJob({ url: "https://example.com/hook", body: { hello: "world" } }, "job_body"),
  );
  assert.ok(built.ok);
  const headers = built.init.headers as Record<string, string>;
  assert.equal(headers["Idempotency-Key"], "job_body");
  assert.equal(headers["content-type"], "application/json");
});

// PR-RETRY-002: 5xx and network failures retry, 4xx does not.
test("status classification follows the PRD's HTTP-backed default", () => {
  assert.equal(classifyStatusCode(200), "success");
  assert.equal(classifyStatusCode(204), "success");
  assert.equal(classifyStatusCode(302), "success");
  assert.equal(classifyStatusCode(500), "retryable");
  assert.equal(classifyStatusCode(503), "retryable");
  assert.equal(classifyStatusCode(400), "nonRetryable");
  assert.equal(classifyStatusCode(404), "nonRetryable");
  assert.equal(classifyStatusCode(422), "nonRetryable");
});

// A 4xx that is transient rather than a bad request. PR-RETRY-002 calls its 4xx
// rule a per-type default, so these are the documented refinement.
test("408 and 429 are retryable despite being 4xx", () => {
  assert.equal(classifyStatusCode(408), "retryable");
  assert.equal(classifyStatusCode(429), "retryable");
});

test("other 4xx codes stay non-retryable", () => {
  for (const status of [400, 401, 403, 404, 405, 409, 410, 422, 451]) {
    assert.equal(classifyStatusCode(status), "nonRetryable", `status ${status}`);
  }
});

// PR-RETRY-004 / rule 5: a payload that can never work is not retried.
test("a payload that is not an object fails without retrying", async () => {
  await expectFailure("a string", "INVALID_PAYLOAD");
  await expectFailure([], "INVALID_PAYLOAD");
  await expectFailure(42, "INVALID_PAYLOAD");
});

test("a missing url fails without retrying", async () => {
  await expectFailure({}, "INVALID_PAYLOAD");
  await expectFailure({ url: 42 }, "INVALID_PAYLOAD");
  await expectFailure({ url: "" }, "INVALID_PAYLOAD");
});

test("a malformed url fails without retrying", async () => {
  await expectFailure({ url: "not-a-url" }, "INVALID_URL");
});

// AGENTS rule 17: http is refused, not attempted.
test("an http url is refused without retrying", async () => {
  await expectFailure({ url: "http://example.com/hook" }, "INSECURE_URL");
});

test("a non-https protocol is refused without retrying", async () => {
  await expectFailure({ url: "ftp://example.com/hook" }, "INSECURE_URL");
});

test("an unsupported method fails without retrying", async () => {
  await expectFailure({ url: "https://example.com/hook", method: "TRACE" }, "INVALID_METHOD");
});

test("a non-string header value fails without retrying", async () => {
  await expectFailure(
    { url: "https://example.com/hook", headers: { "x-n": 5 } },
    "INVALID_PAYLOAD",
  );
});

// A network failure is the one failure that must stay retryable.
test("an unreachable endpoint is retryable", async () => {
  const result = await executeWebhookCall(
    claimedJob({ url: "https://127.0.0.1:1/hook" }),
  );
  assert.equal(result.kind, "failure");
  assert.ok(result.kind === "failure");
  assert.equal(result.errorCode, "NETWORK_ERROR");
  assert.equal(result.retryable, true);
});
