import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { marksAgree } from "../src/mark/agreement.js";
import type { MarkPayload } from "../src/mark/forms.js";

describe("mark agreement (J3)", () => {
  it("two matching pass_fail marks agree", () => {
    const a: MarkPayload = {
      form_type: "pass_fail",
      pass_fail: "pass",
      expected_text: "Thanks!",
    };
    const b: MarkPayload = {
      form_type: "pass_fail",
      pass_fail: "pass",
      expected_text: "Thanks!",
    };
    assert.deepEqual(marksAgree(a, b), { agree: true });
  });

  it("trims text before comparing expected_text", () => {
    const a: MarkPayload = {
      form_type: "text",
      expected_text: " hello ",
    };
    const b: MarkPayload = {
      form_type: "text",
      expected_text: "hello",
    };
    assert.deepEqual(marksAgree(a, b), { agree: true });
  });

  it("optional why is ignored for agreement", () => {
    const a: MarkPayload = {
      form_type: "pass_fail",
      pass_fail: "pass",
      why: "looks fine",
    };
    const b: MarkPayload = {
      form_type: "pass_fail",
      pass_fail: "pass",
      why: "different note",
    };
    assert.deepEqual(marksAgree(a, b), { agree: true });
  });

  it("one accept and one edit disagree", () => {
    const a: MarkPayload = {
      form_type: "pass_fail",
      pass_fail: "pass",
      expected_text: "draft reply",
    };
    const b: MarkPayload = {
      form_type: "pass_fail",
      pass_fail: "pass",
      expected_text: "edited reply",
    };
    const result = marksAgree(a, b);
    assert.equal(result.agree, false);
  });

  it("pass_fail choice mismatch disagrees", () => {
    const a: MarkPayload = { form_type: "pass_fail", pass_fail: "pass" };
    const b: MarkPayload = { form_type: "pass_fail", pass_fail: "fail" };
    const result = marksAgree(a, b);
    assert.equal(result.agree, false);
  });

  it("rubric marks must match every check", () => {
    const a: MarkPayload = {
      form_type: "rubric",
      rubric: { tone: "pass", length: "pass" },
    };
    const b: MarkPayload = {
      form_type: "rubric",
      rubric: { tone: "pass", length: "fail" },
    };
    assert.equal(marksAgree(a, b).agree, false);
  });
});
