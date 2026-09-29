import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { JobStatus } from "@prisma/client";

import {
  buildWebhookPayload,
  isTerminalJobStatus,
  JOB_WEBHOOK_EVENT,
} from "../../modules/webhooks/payload";
import {
  InsecureWebhookUrlError,
  InvalidWebhookUrlError,
  assertHttpsWebhookUrl,
} from "../../modules/webhooks/endpoint-url";
import {
  SIGNATURE_HEADER,
  signWebhookPayload,
  verifyWebhookSignature,
  generateWebhookSecret,
} from "../../modules/webhooks/signature";
import { MAX_DELIVERY_ATTEMPTS } from "../../modules/webhooks/delivery-policy";

test("PR-WEBHOOK-001: an http url is rejected rather than accepted or upgraded", () => {
  assert.throws(() => assertHttpsWebhookUrl("http://example.com/hook"), InsecureWebhookUrlError);
});

test("PR-WEBHOOK-001: a non-http protocol is rejected", () => {
  assert.throws(() => assertHttpsWebhookUrl("ftp://example.com/hook"), InsecureWebhookUrlError);
});

test("PR-WEBHOOK-001: a url that is not a url at all is rejected", () => {
  assert.throws(() => assertHttpsWebhookUrl("not a url"), InvalidWebhookUrlError);
});

test("PR-WEBHOOK-001: an https url is accepted", () => {
  assert.equal(assertHttpsWebhookUrl("https://example.com/hook").protocol, "https:");
});

test("PR-WEBHOOK-003: the signature header is named and prefixed as specified", () => {
  const signature = signWebhookPayload("secret", "body");
  assert.equal(SIGNATURE_HEADER, "X-RenderFlow-Signature");
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
});

test("PR-WEBHOOK-003: a correct signature verifies", () => {
  const body = JSON.stringify({ job: { id: "abc" } });
  assert.equal(verifyWebhookSignature("s3cret", body, signWebhookPayload("s3cret", body)), true);
});

test("PR-WEBHOOK-003: a signature from a different secret does not verify", () => {
  const body = "{}";
  assert.equal(verifyWebhookSignature("secret-a", body, signWebhookPayload("secret-b", body)), false);
});

test("PR-WEBHOOK-003: a signature over different bytes does not verify", () => {
  assert.equal(
    verifyWebhookSignature("secret", '{"a":1}', signWebhookPayload("secret", '{"a":2}')),
    false,
  );
});

test("PR-WEBHOOK-003: a truncated or malformed signature does not verify", () => {
  assert.equal(verifyWebhookSignature("secret", "{}", "sha256=deadbeef"), false);
  assert.equal(verifyWebhookSignature("secret", "{}", "not-prefixed"), false);
});

test("PR-WEBHOOK-003: the signature matches an independent hmac of the same bytes", () => {
  const body = JSON.stringify({ hello: "world" });
  const expected = createHmac("sha256", "key").update(body, "utf8").digest("hex");
  assert.equal(signWebhookPayload("key", body), `sha256=${expected}`);
});

test("PR-WEBHOOK-002: the payload carries id, type, status, and a result or error", () => {
  const body = JSON.parse(
    buildWebhookPayload(
      {
        id: "job_1",
        type: "WEBHOOK_CALL",
        status: JobStatus.SUCCEEDED,
        attempts: 1,
        finishedAt: new Date("2026-01-01T00:00:00.000Z"),
        result: { ok: true },
        lastError: null,
      },
      new Date("2026-01-01T00:00:01.000Z"),
    ),
  );

  assert.equal(body.event, JOB_WEBHOOK_EVENT);
  assert.equal(body.job.id, "job_1");
  assert.equal(body.job.type, "WEBHOOK_CALL");
  assert.equal(body.job.status, "SUCCEEDED");
  assert.deepEqual(body.job.result, { ok: true });
  assert.equal(body.job.error, null);
});

test("PR-WEBHOOK-002: a failed job's payload carries the error summary", () => {
  const body = JSON.parse(
    buildWebhookPayload({
      id: "job_2",
      type: "EMAIL_DELIVERY",
      status: JobStatus.DEAD,
      attempts: 5,
      finishedAt: new Date("2026-01-01T00:00:00.000Z"),
      result: null,
      lastError: "HTTP 400 from provider",
    }),
  );

  assert.equal(body.job.status, "DEAD");
  assert.equal(body.job.error, "HTTP 400 from provider");
  assert.equal(body.job.result, null);
});

test("PR-WEBHOOK-002: a null finishedAt serialises as null rather than Invalid Date", () => {
  const body = JSON.parse(
    buildWebhookPayload({
      id: "job_3",
      type: "CUSTOM",
      status: JobStatus.SUCCEEDED,
      attempts: 1,
      finishedAt: null,
      result: null,
      lastError: null,
    }),
  );
  assert.equal(body.job.finishedAt, null);
});

test("only terminal statuses trigger a notification", () => {
  assert.equal(isTerminalJobStatus(JobStatus.SUCCEEDED), true);
  assert.equal(isTerminalJobStatus(JobStatus.DEAD), true);
  assert.equal(isTerminalJobStatus(JobStatus.FAILED), false);
  assert.equal(isTerminalJobStatus(JobStatus.PROCESSING), false);
  assert.equal(isTerminalJobStatus(JobStatus.QUEUED), false);
});

test("PR-WEBHOOK-004: delivery stops at 3 attempts", () => {
  assert.equal(MAX_DELIVERY_ATTEMPTS, 3);
});

test("a generated secret is prefixed and long enough to be unguessable", () => {
  const secret = generateWebhookSecret();
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(secret, generateWebhookSecret());
});
