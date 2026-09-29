import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readPositiveInteger } from "../../../lib/config/env";

describe("readPositiveInteger", () => {
  it("returns the fallback when unset", () => {
    assert.equal(readPositiveInteger("MISSING", 10, {}), 10);
  });

  it("returns the fallback when blank", () => {
    assert.equal(readPositiveInteger("BLANK", 10, { BLANK: "   " }), 10);
  });

  it("parses a positive integer", () => {
    assert.equal(readPositiveInteger("SET", 10, { SET: "25" }), 25);
  });

  it("rejects zero", () => {
    // A zero interval or timeout would spin the sweep or disable recovery
    // entirely, so it is refused rather than silently accepted.
    assert.throws(() => readPositiveInteger("ZERO", 10, { ZERO: "0" }), /positive integer/);
  });

  it("rejects a negative value", () => {
    assert.throws(() => readPositiveInteger("NEG", 10, { NEG: "-1" }), /positive integer/);
  });

  it("rejects a fractional value", () => {
    assert.throws(() => readPositiveInteger("FRAC", 10, { FRAC: "1.5" }), /positive integer/);
  });

  it("rejects a non-numeric value", () => {
    assert.throws(() => readPositiveInteger("TEXT", 10, { TEXT: "abc" }), /positive integer/);
  });
});
