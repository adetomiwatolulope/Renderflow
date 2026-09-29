import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalJsonString, payloadsAreDeepEqual } from "../../modules/jobs/canonical-json";

test("key order does not affect equality", () => {
  assert.equal(
    payloadsAreDeepEqual({ b: 1, a: { d: 2, c: 3 } }, { a: { c: 3, d: 2 }, b: 1 }),
    true,
  );
});

test("array order does affect equality", () => {
  assert.equal(payloadsAreDeepEqual({ a: [1, 2] }, { a: [2, 1] }), false);
});

test("a differing value is not equal", () => {
  assert.equal(payloadsAreDeepEqual({ a: 1 }, { a: 2 }), false);
});

test("an extra key is not equal", () => {
  assert.equal(payloadsAreDeepEqual({ a: 1 }, { a: 1, b: 2 }), false);
});

test("a different key name is not equal", () => {
  assert.equal(payloadsAreDeepEqual({ a: 1 }, { b: 1 }), false);
});

test("null and an absent key are not equal", () => {
  assert.equal(payloadsAreDeepEqual({ a: null }, {}), false);
});

test("nested types are not conflated", () => {
  assert.equal(payloadsAreDeepEqual({ a: "1" }, { a: 1 }), false);
  assert.equal(payloadsAreDeepEqual({ a: true }, { a: "true" }), false);
});

test("canonical form is stable across differing key orders", () => {
  assert.equal(
    canonicalJsonString({ z: 1, a: { y: 2, b: 3 } }),
    canonicalJsonString({ a: { b: 3, y: 2 }, z: 1 }),
  );
});
