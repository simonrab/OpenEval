import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreProgramCheck } from "../../src/scoring/index.js";

describe("V1 scorer primitives", () => {
  it("scores json_schema", () => {
    const pass = scoreProgramCheck('{"label":"billing"}', {
      kind: "json_schema",
      expected: {
        type: "object",
        required: ["label"],
        properties: { label: { enum: ["billing", "support"] } },
      },
    });
    assert.equal(pass.passed, true);

    const fail = scoreProgramCheck('{"label":"sales"}', {
      kind: "json_schema",
      expected: {
        type: "object",
        required: ["label"],
        properties: { label: { enum: ["billing", "support"] } },
      },
    });
    assert.equal(fail.passed, false);
  });

  it("scores regex_match", () => {
    assert.equal(
      scoreProgramCheck("Ticket ID: ABC-123", {
        kind: "regex_match",
        expected: { pattern: "ABC-\\d+" },
      }).passed,
      true,
    );
  });

  it("scores numeric_close with JSON paths", () => {
    assert.equal(
      scoreProgramCheck('{"total":104.34}', {
        kind: "numeric_close",
        expected: { path: "total", value: 104.35, tolerance: 0.02 },
      }).passed,
      true,
    );
  });

  it("scores set_equals without order", () => {
    assert.equal(
      scoreProgramCheck('{"ids":["b","a"]}', {
        kind: "set_equals",
        expected: { path: "ids", values: ["a", "b"] },
      }).passed,
      true,
    );
  });

  it("scores tool_args", () => {
    assert.equal(
      scoreProgramCheck('{"name":"search","arguments":{"query":"refund"}}', {
        kind: "tool_args",
        expected: { name: "search", args: { query: "refund" } },
      }).passed,
      true,
    );
  });

  it("scores trace_rule", () => {
    assert.equal(
      scoreProgramCheck("plan\nsearch docs\nfinal answer", {
        kind: "trace_rule",
        expected: { ordered: ["search docs", "final answer"], max_steps: 3 },
      }).passed,
      true,
    );
  });

  it("scores citation_support", () => {
    assert.equal(
      scoreProgramCheck("The refund window is 30 days [policy].", {
        kind: "citation_support",
        expected: { sources: ["policy"], require_all: true },
      }).passed,
      true,
    );
  });

  it("scores retrieval_contains", () => {
    assert.equal(
      scoreProgramCheck("Refunds are available for 30 days.", {
        kind: "retrieval_contains",
        expected: { required: ["30 days"], mode: "all" },
      }).passed,
      true,
    );
  });

  it("scores pairwise_equals", () => {
    assert.equal(
      scoreProgramCheck('{"a":{"route":"billing"},"b":{"route":"billing"}}', {
        kind: "pairwise_equals",
        expected: { pairs: [{ left_path: "a.route", right_path: "b.route" }] },
      }).passed,
      true,
    );
  });

  it("fails invalid primitive specs closed", () => {
    assert.equal(
      scoreProgramCheck("x", { kind: "numeric_close", expected: {} }).passed,
      false,
    );
  });
});
