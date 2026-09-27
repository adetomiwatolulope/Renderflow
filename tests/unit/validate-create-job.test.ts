import assert from "node:assert/strict";
import { test } from "node:test";

import { InvalidJobSubmissionError } from "../../modules/jobs/errors";
import {
  MAX_PAYLOAD_BYTES,
  validateJobSubmission,
} from "../../modules/jobs/validate-create-job";

function fieldErrorsFor(body: unknown): Record<string, string> {
  try {
    validateJobSubmission(body);
  } catch (error) {
    assert.ok(error instanceof InvalidJobSubmissionError);
    return { ...error.fieldErrors };
  }
  assert.fail("expected the submission to be rejected");
}

test("accepts a minimal valid submission", () => {
  const validated = validateJobSubmission({
    type: "CUSTOM",
    payload: { hello: "world" },
    idempotencyKey: "key-1",
  });

  assert.equal(validated.type, "CUSTOM");
  assert.equal(validated.idempotencyKey, "key-1");
  assert.deepEqual(validated.payload, { hello: "world" });
});

test("accepts every JobType the PRD defines", () => {
  for (const type of [
    "PDF_GENERATION",
    "IMAGE_PROCESSING",
    "EMAIL_DELIVERY",
    "AI_REQUEST",
    "WEBHOOK_CALL",
    "CUSTOM",
  ]) {
    const validated = validateJobSubmission({
      type,
      payload: {},
      idempotencyKey: `key-${type}`,
    });
    assert.equal(validated.type, type);
  }
});

test("rejects an unknown type", () => {
  assert.ok("type" in fieldErrorsFor({ type: "NOT_A_TYPE", payload: {}, idempotencyKey: "k" }));
});

test("rejects a missing idempotency key", () => {
  assert.ok("idempotencyKey" in fieldErrorsFor({ type: "CUSTOM", payload: {} }));
});

test("rejects a blank idempotency key", () => {
  assert.ok(
    "idempotencyKey" in fieldErrorsFor({ type: "CUSTOM", payload: {}, idempotencyKey: "   " }),
  );
});

test("rejects a non-object payload", () => {
  for (const payload of ["a string", 42, true, null, [1, 2, 3]]) {
    assert.ok("payload" in fieldErrorsFor({ type: "CUSTOM", payload, idempotencyKey: "k" }));
  }
});

// CS-14 / AGENTS rule 5: the forbidden submission must be refused, not dropped.
test("rejects a client-submitted maxAttempts", () => {
  assert.ok(
    "maxAttempts" in
      fieldErrorsFor({ type: "CUSTOM", payload: {}, idempotencyKey: "k", maxAttempts: 99 }),
  );
});

test("rejects a client-submitted priority", () => {
  assert.ok(
    "priority" in fieldErrorsFor({ type: "CUSTOM", payload: {}, idempotencyKey: "k", priority: 1 }),
  );
});

test("rejects a client-submitted scheduledFor", () => {
  assert.ok(
    "scheduledFor" in
      fieldErrorsFor({ type: "CUSTOM", payload: {}, idempotencyKey: "k", scheduledFor: "2030-01-01" }),
  );
});

// CS-1 / CS-12 / AGENTS rule 2: a client cannot set anything the server owns.
test("rejects a client trying to set status, accountId or the lifecycle fields", () => {
  for (const field of [
    "status",
    "accountId",
    "attempts",
    "runAt",
    "result",
    "lastError",
  ]) {
    const errors = fieldErrorsFor({
      type: "CUSTOM",
      payload: {},
      idempotencyKey: "k",
      [field]: "whatever",
    });
    assert.ok(field in errors, `expected ${field} to be rejected`);
  }
});

test("rejects an unrecognised field", () => {
  assert.ok("typo" in fieldErrorsFor({ type: "CUSTOM", payload: {}, idempotencyKey: "k", typo: 1 }));
});

// PR-JOB-008: over the cap, and no row may be created.
test("rejects a payload over 256KB", () => {
  const oversized = { blob: "x".repeat(MAX_PAYLOAD_BYTES + 1) };
  const errors = fieldErrorsFor({
    type: "CUSTOM",
    payload: oversized,
    idempotencyKey: "k",
  });
  assert.ok("payload" in errors);
});

test("accepts a payload just under the cap", () => {
  const filler = "x".repeat(MAX_PAYLOAD_BYTES - 64);
  const validated = validateJobSubmission({
    type: "CUSTOM",
    payload: { filler },
    idempotencyKey: "k",
  });
  assert.equal(typeof validated.payload.filler, "string");
});

test("the cap is measured in bytes, not characters", () => {
  // Four bytes per character: a payload well under MAX_PAYLOAD_BYTES characters
  // must still be rejected once encoded as UTF-8.
  const multibyte = { blob: "\u00e9".repeat(MAX_PAYLOAD_BYTES) };
  const errors = fieldErrorsFor({ type: "CUSTOM", payload: multibyte, idempotencyKey: "k" });
  assert.ok("payload" in errors);
});

test("rejects a non-object body", () => {
  for (const body of ["string", 7, null, []]) {
    assert.ok("body" in fieldErrorsFor(body));
  }
});

test("rejects values JSON cannot represent", () => {
  assert.ok(
    "payload" in
      fieldErrorsFor({ type: "CUSTOM", payload: { n: Number.POSITIVE_INFINITY }, idempotencyKey: "k" }),
  );
  assert.ok(
    "payload" in
      fieldErrorsFor({ type: "CUSTOM", payload: { n: Number.NaN }, idempotencyKey: "k" }),
  );
});
