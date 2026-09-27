import assert from "node:assert/strict";
import { test } from "node:test";

import { failureFromThrownError } from "../../worker/failure";

/**
 * Owner's Step 4: work that throws follows the normal failure path — increment
 * attempts, record lastError, back off, and only reach DEAD once maxAttempts is
 * reached. So a throw must be classified retryable, not terminal.
 */

test("a thrown error is retryable", () => {
  const result = failureFromThrownError(new Error("boom"));
  assert.equal(result.kind, "failure");
  assert.ok(result.kind === "failure");
  assert.equal(result.retryable, true);
});

test("the thrown error's message becomes the failure message", () => {
  const result = failureFromThrownError(new Error("connection reset"));
  assert.ok(result.kind === "failure");
  assert.equal(result.errorMessage, "connection reset");
  assert.equal(result.errorCode, "EXECUTOR_THREW");
});

// A throw that is not an Error still has to produce a usable message rather than
// crashing the worker's error path.
test("a non-Error throw is stringified", () => {
  const result = failureFromThrownError("just a string");
  assert.ok(result.kind === "failure");
  assert.equal(result.errorMessage, "just a string");
  assert.equal(result.retryable, true);
});

test("an undefined throw still produces a retryable failure", () => {
  const result = failureFromThrownError(undefined);
  assert.ok(result.kind === "failure");
  assert.equal(result.retryable, true);
  assert.equal(result.errorMessage, "undefined");
});
