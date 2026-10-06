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

describe("Phase 5 scorer primitives", () => {
  const score = (output: string, kind: string, expected: unknown) =>
    scoreProgramCheck(output, { kind: kind as never, expected });

  it("regex_match reads a JSON path and honors flags", () => {
    assert.equal(score('{"id":"abc-12"}', "regex_match", { pattern: "^ABC-\\d+$", flags: "i", path: "id" }).passed, true);
    assert.equal(score('{"id":"x"}', "regex_match", { pattern: "^ABC", path: "id" }).passed, false);
    assert.equal(score('{"id":"x"}', "regex_match", { pattern: "x", path: "nope" }).reason_short, "nope missing");
  });

  it("regex_match refuses unsafe patterns and long inputs", () => {
    assert.equal(score("aaaa", "regex_match", { pattern: "(a+)+$" }).reason_short, "nested quantifier");
    assert.equal(score("aa", "regex_match", { pattern: "(a)\\1" }).reason_short, "backreference");
    assert.equal(score("a", "regex_match", { pattern: "a".repeat(201) }).reason_short, "pattern too long");
    assert.equal(score("a", "regex_match", { pattern: "a", flags: "g" }).reason_short, "bad regex flags");
    const long = score("a".repeat(20_001), "regex_match", { pattern: "a" });
    assert.equal(long.passed, false);
    assert.equal(long.reason_short, "output too long for regex");
  });

  it("numeric_close uses abs_tol and rel_tol", () => {
    assert.equal(score('{"t":10.4}', "numeric_close", { path: "t", value: 10, abs_tol: 0.5 }).passed, true);
    assert.equal(score('{"t":10.6}', "numeric_close", { path: "t", value: 10, abs_tol: 0.5 }).passed, false);
    assert.equal(score("Total: 1040", "numeric_close", { value: 1000, rel_tol: 0.05 }).passed, true);
    assert.equal(score("Total: 1060", "numeric_close", { value: 1000, rel_tol: 0.05 }).passed, false);
    assert.equal(score("0.30000000000000004", "numeric_close", { value: 0.3 }).passed, true);
    assert.equal(score('{"t":"n/a"}', "numeric_close", { path: "t", value: 1 }).reason_short, "numeric value missing");
  });

  it("set_equals handles case and order", () => {
    assert.equal(
      score('{"tags":["B","a"]}', "set_equals", { path: "tags", values: ["a", "b"], case_insensitive: true }).passed,
      true,
    );
    assert.equal(score('{"tags":["B","a"]}', "set_equals", { path: "tags", values: ["a", "b"] }).passed, false);
    const ordered = score('{"tags":["b","a"]}', "set_equals", { path: "tags", values: ["a", "b"], ignore_order: false });
    assert.equal(ordered.passed, false);
    assert.equal(ordered.reason_short, "set order mismatch");
    assert.equal(
      score('{"tags":["a","c"]}', "set_equals", { path: "tags", values: ["a", "b"] }).reason_short,
      "set mismatch: 1 missing, 1 extra",
    );
  });

  it("contains_all and contains_any", () => {
    assert.equal(score("Refund in 30 days", "contains_all", { values: ["refund", "30 days"], case_insensitive: true }).passed, true);
    const miss = score("Refund in 30 days", "contains_all", { values: ["refund", "receipt"] });
    assert.equal(miss.passed, false);
    assert.equal(miss.reason_short, "2 of 2 missing");
    assert.equal(score("Call us", "contains_any", { values: ["email", "call"], case_insensitive: true }).passed, true);
    assert.equal(score("Call us", "contains_any", { values: ["email", "chat"] }).reason_short, "none of 2 present");
    assert.equal(score("x", "contains_all", { values: [] }).reason_short, "bad contains_all spec");
  });

  it("length_range checks chars and words", () => {
    assert.equal(score("one two three", "length_range", { min_words: 2, max_words: 3 }).passed, true);
    assert.equal(score("one two three four", "length_range", { max_words: 3 }).reason_short, "4 words, max 3");
    assert.equal(score("  hi  ", "length_range", { min_chars: 3 }).reason_short, "2 chars, min 3");
    assert.equal(score("hello", "length_range", { max_chars: 4 }).passed, false);
    assert.equal(score("hello", "length_range", {}).reason_short, "bad length_range spec");
  });

  it("json_schema checks string, number, and array bounds", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 2, maxLength: 5 },
        qty: { type: "integer", minimum: 1, maximum: 9 },
        tags: { type: "array", minItems: 1, maxItems: 2 },
      },
    };
    assert.equal(score('{"name":"abc","qty":3,"tags":["a"]}', "json_schema", schema).passed, true);
    assert.equal(score('{"name":"a"}', "json_schema", schema).reason_short, "name too short");
    assert.equal(score('{"qty":10}', "json_schema", schema).reason_short, "qty above maximum");
    assert.equal(score('{"tags":[]}', "json_schema", schema).reason_short, "tags too few items");
  });

  it("never echoes the output in reason_short", () => {
    const secret = "sk-or-v1-SECRETSECRET";
    for (const [kind, expected] of [
      ["regex_match", { pattern: "^nomatch$" }],
      ["contains_all", { values: ["absent"] }],
      ["length_range", { max_chars: 3 }],
      ["set_equals", { values: ["a"] }],
    ] as const) {
      assert.equal(score(secret, kind, expected).reason_short.includes(secret), false, kind);
    }
  });
});
