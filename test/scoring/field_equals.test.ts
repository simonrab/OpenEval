import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreFieldEquals } from "../../src/scoring/field_equals.js";

describe("scoreFieldEquals", () => {
  it("checks field exists", () => {
    const out = '{"line_items":[],"total_cents":100}';
    const r = scoreFieldEquals(out, {
      path: "total_cents",
      exists: true,
    });
    assert.equal(r.passed, true);
  });

  it("fails when field missing", () => {
    const r = scoreFieldEquals('{"line_items":[]}', {
      path: "total_cents",
      exists: true,
    });
    assert.equal(r.passed, false);
    assert.match(r.reason_short, /missing/i);
  });

  it("checks array type", () => {
    const r = scoreFieldEquals('{"line_items":[]}', {
      path: "line_items",
      exists: true,
      type: "array",
    });
    assert.equal(r.passed, true);
  });
});
