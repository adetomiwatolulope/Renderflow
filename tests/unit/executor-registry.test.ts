import assert from "node:assert/strict";
import { test } from "node:test";

import { JobType } from "@prisma/client";

import { executableJobTypes, resolveExecutor } from "../../worker/executors/registry";

/**
 * WEBHOOK_CALL is the one registered type. The unregistered types must stay
 * unclaimed rather than be driven to DEAD by attempts that could not run, which
 * is what `executableJobTypes()` gates.
 */

test("WEBHOOK_CALL is the only executable type", () => {
  assert.deepEqual(executableJobTypes(), [JobType.WEBHOOK_CALL]);
});

test("an unregistered type resolves to no executor", () => {
  for (const type of [
    JobType.PDF_GENERATION,
    JobType.IMAGE_PROCESSING,
    JobType.EMAIL_DELIVERY,
    JobType.AI_REQUEST,
    JobType.CUSTOM,
  ]) {
    assert.equal(resolveExecutor(type), null);
    assert.ok(!executableJobTypes().includes(type));
  }
});

test("WEBHOOK_CALL resolves to an executor", () => {
  assert.equal(typeof resolveExecutor(JobType.WEBHOOK_CALL), "function");
});
