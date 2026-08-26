import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreToolName } from "../../src/scoring/tool_name.js";

describe("scoreToolName", () => {
  it("matches plain tool name", () => {
    const r = scoreToolName("search", "search");
    assert.equal(r.passed, true);
  });

  it("matches JSON tool field", () => {
    const r = scoreToolName('{"name":"search"}', "search");
    assert.equal(r.passed, true);
  });
});
