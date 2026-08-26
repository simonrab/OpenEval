import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreMustNotContain } from "../../src/scoring/must_not_contain.js";

describe("scoreMustNotContain", () => {
  it("passes when forbidden text absent", () => {
    const r = scoreMustNotContain('{"a":1}', "```");
    assert.equal(r.passed, true);
  });

  it("fails when markdown fence present", () => {
    const r = scoreMustNotContain("```json\n{}", "```");
    assert.equal(r.passed, false);
  });
});
