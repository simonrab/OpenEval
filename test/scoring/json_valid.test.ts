import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreJsonValid } from "../../src/scoring/json_valid.js";

describe("scoreJsonValid", () => {
  it("passes valid JSON object", () => {
    const r = scoreJsonValid('{"line_items":[],"total_cents":100}', true);
    assert.equal(r.passed, true);
  });

  it("fails invalid JSON", () => {
    const r = scoreJsonValid("not json", true);
    assert.equal(r.passed, false);
    assert.match(r.reason_short, /invalid JSON/i);
  });

  it("passes JSON inside markdown fence", () => {
    const r = scoreJsonValid("```json\n{\"a\":1}\n```", true);
    assert.equal(r.passed, true);
  });
});
