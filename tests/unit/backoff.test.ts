import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  JITTER_RATIO,
  backoffDelayMs,
  nextRunAt,
} from "../../modules/retry/backoff";

/** Deterministic entropy: always the low end, always the high end, and midway. */
const alwaysZero = (): number => 0;
const alwaysOne = (): number => 1;
const halfway = (): number => 0.5;

/** The exponential term on its own, i.e. the delay with no jitter. */
function exponentialOnly(attemptNumber: number): number {
  return backoffDelayMs(attemptNumber, alwaysZero);
}

test("the first failure waits one base delay", () => {
  assert.equal(exponentialOnly(1), BACKOFF_BASE_MS);
});

test("the exponential term doubles per attempt", () => {
  assert.equal(exponentialOnly(2), BACKOFF_BASE_MS * 2);
  assert.equal(exponentialOnly(3), BACKOFF_BASE_MS * 4);
  assert.equal(exponentialOnly(4), BACKOFF_BASE_MS * 8);
});

test("an attempt number below 1 does not produce a delay below the base", () => {
  assert.equal(exponentialOnly(0), BACKOFF_BASE_MS);
  assert.equal(exponentialOnly(-3), BACKOFF_BASE_MS);
});

// Owner's Step 4: the random offset is what stops a herd of simultaneous
// failures from retrying in lockstep.
test("jitter adds an offset on top of the exponential term", () => {
  assert.equal(backoffDelayMs(1, alwaysZero), BACKOFF_BASE_MS);
  assert.equal(backoffDelayMs(1, alwaysOne), BACKOFF_BASE_MS * (1 + JITTER_RATIO));
  assert.equal(backoffDelayMs(1, halfway), BACKOFF_BASE_MS + Math.floor(BACKOFF_BASE_MS * JITTER_RATIO * 0.5));
});

test("jitter never subtracts from the exponential term", () => {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    for (const random of [alwaysZero, halfway, alwaysOne]) {
      assert.ok(backoffDelayMs(attempt, random) >= exponentialOnly(attempt));
    }
  }
});

test("jitter stays within the ratio", () => {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const base = exponentialOnly(attempt);
    assert.ok(backoffDelayMs(attempt, alwaysOne) <= base * (1 + JITTER_RATIO));
  }
});

// The cap must hold for the total, jitter included, or retries would keep
// drifting past the documented maximum.
test("jitter never pushes the delay past the cap", () => {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    for (const random of [alwaysZero, halfway, alwaysOne]) {
      assert.ok(backoffDelayMs(attempt, random) <= BACKOFF_MAX_MS, `attempt ${attempt}`);
    }
  }
});

test("the delay saturates at the cap", () => {
  assert.equal(backoffDelayMs(30, alwaysOne), BACKOFF_MAX_MS);
  assert.equal(backoffDelayMs(30, alwaysZero), BACKOFF_MAX_MS);
});

test("a real random source spreads retries instead of synchronising them", () => {
  const first = backoffDelayMs(4, alwaysZero);
  const samples = new Set<number>();
  for (let i = 0; i < 25; i += 1) {
    samples.add(backoffDelayMs(4));
  }
  assert.ok(samples.size > 1, "jitter must actually vary between calls");
  for (const sample of samples) {
    assert.ok(sample >= first && sample <= first * (1 + JITTER_RATIO));
  }
});

test("the next run is always strictly in the future", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  for (const random of [alwaysZero, halfway, alwaysOne]) {
    const next = nextRunAt(now, 1, random);
    assert.ok(next.getTime() > now.getTime());
  }
});

test("the next run carries the jittered delay", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const next = nextRunAt(now, 2, alwaysOne);
  assert.equal(next.getTime() - now.getTime(), backoffDelayMs(2, alwaysOne));
});

test("the growth is monotonic at the low end of the jitter range", () => {
  for (let attempt = 2; attempt <= 10; attempt += 1) {
    assert.ok(exponentialOnly(attempt) >= exponentialOnly(attempt - 1));
  }
});
