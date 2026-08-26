import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ERROR_CODES,
  ErrorCode,
  agentErrorSchema,
  isAgentError,
} from "../src/tools/types.js";
import { agentError } from "../src/errors.js";
import { notBuiltError } from "../src/tools/not-built.js";

const SPEC_CODES = [
  "need_more_evals",
  "does_not_work",
  "need_new_model",
  "evals_missing_new_failures",
  "COST_CAP_EXCEEDED",
  "JOB_UNCLEAR",
  "PROJECT_NOT_FOUND",
  "SUITE_NOT_FOUND",
  "NAMED_MODEL_MISMATCH",
  "COST_CAP_REQUIRED",
] as const;

describe("error codes", () => {
  for (const code of SPEC_CODES) {
    it(`includes spec code ${code}`, () => {
      assert.equal(ErrorCode[code], code);
      assert.ok(ERROR_CODES.includes(code));
    });
  }

  it("includes a stable NOT_BUILT code", () => {
    assert.equal(ErrorCode.NOT_BUILT, "NOT_BUILT");
    assert.ok(ERROR_CODES.includes("NOT_BUILT"));
  });

  it("includes UNKNOWN_TOOL for an unknown name", () => {
    assert.equal(ErrorCode.UNKNOWN_TOOL, "UNKNOWN_TOOL");
  });

  it("includes NO_LAST_KNOWN_POLICY for Live GET", () => {
    assert.equal(ErrorCode.NO_LAST_KNOWN_POLICY, "NO_LAST_KNOWN_POLICY");
    assert.ok(ERROR_CODES.includes("NO_LAST_KNOWN_POLICY"));
  });

  it("includes REC_NOT_APPROVED and STE_MISMATCH for Live compile", () => {
    assert.equal(ErrorCode.REC_NOT_APPROVED, "REC_NOT_APPROVED");
    assert.ok(ERROR_CODES.includes("REC_NOT_APPROVED"));
    assert.equal(ErrorCode.STE_MISMATCH, "STE_MISMATCH");
    assert.ok(ERROR_CODES.includes("STE_MISMATCH"));
  });

  it("includes PII_BLOCKED and CONTROL_PLANE_UNREACHABLE for Live samples", () => {
    assert.equal(ErrorCode.PII_BLOCKED, "PII_BLOCKED");
    assert.ok(ERROR_CODES.includes("PII_BLOCKED"));
    assert.equal(ErrorCode.CONTROL_PLANE_UNREACHABLE, "CONTROL_PLANE_UNREACHABLE");
    assert.ok(ERROR_CODES.includes("CONTROL_PLANE_UNREACHABLE"));
  });

  it("includes NOT_A_SAMPLE for Live promote", () => {
    assert.equal(ErrorCode.NOT_A_SAMPLE, "NOT_A_SAMPLE");
    assert.ok(ERROR_CODES.includes("NOT_A_SAMPLE"));
  });

  it("includes POLICY_NOT_APPROVED and CANARY_NOT_ACTIVE for Live rollout", () => {
    assert.equal(ErrorCode.POLICY_NOT_APPROVED, "POLICY_NOT_APPROVED");
    assert.ok(ERROR_CODES.includes("POLICY_NOT_APPROVED"));
    assert.equal(ErrorCode.CANARY_NOT_ACTIVE, "CANARY_NOT_ACTIVE");
    assert.ok(ERROR_CODES.includes("CANARY_NOT_ACTIVE"));
  });
});

describe("agent error envelope", () => {
  it("requires code, message, next_action, retryable, suggested_tool, suggested_args", () => {
    const envelope = agentError({
      code: ErrorCode.need_more_evals,
      message: "8 trusted evals; need more before naming a model",
      retryable: true,
      suggested_tool: "queue_for_labeling",
      suggested_args: {},
      next_action: {
        tool: "queue_for_labeling",
        args: {},
        ask_human: "open mark_url",
      },
    });

    assert.equal(envelope.code, "need_more_evals");
    assert.equal(typeof envelope.message, "string");
    assert.equal(envelope.retryable, true);
    assert.equal(envelope.suggested_tool, "queue_for_labeling");
    assert.deepEqual(envelope.suggested_args, {});
    assert.ok(envelope.next_action);
    assert.equal(envelope.next_action.tool, "queue_for_labeling");
    assert.deepEqual(envelope.next_action.args, {});
    assert.equal(envelope.next_action.ask_human, "open mark_url");
    assert.equal(isAgentError(envelope), true);
    assert.ok(agentErrorSchema.safeParse(envelope).success);
  });

  it("allows optional run_id, failing_eval_ids, and mark_url", () => {
    const envelope = agentError({
      code: ErrorCode.does_not_work,
      message: "No model passed",
      retryable: false,
      suggested_tool: null,
      suggested_args: {},
      next_action: {
        tool: null,
        args: {},
        ask_human: "none of the models passed; see failing_eval_ids",
      },
      run_id: "run_abc",
      failing_eval_ids: ["cas_1"],
      mark_url: null,
    });

    assert.equal(envelope.run_id, "run_abc");
    assert.deepEqual(envelope.failing_eval_ids, ["cas_1"]);
    assert.equal(envelope.mark_url, null);
    assert.ok(agentErrorSchema.safeParse(envelope).success);
  });

  it("next_action is never optional", () => {
    const envelope = notBuiltError("run_evals");
    assert.ok("next_action" in envelope);
    assert.equal(typeof envelope.next_action, "object");
    assert.ok(envelope.next_action !== null);
    assert.ok("tool" in envelope.next_action);
    assert.ok("args" in envelope.next_action);
    assert.ok("ask_human" in envelope.next_action);
  });

  it("not-built envelope uses the stable code and a next_action", () => {
    const envelope = notBuiltError("run_evals");
    assert.equal(envelope.code, ErrorCode.NOT_BUILT);
    assert.equal(typeof envelope.message, "string");
    assert.equal(envelope.next_action.tool, "run_evals");
    assert.deepEqual(envelope.next_action.args, {});
    assert.equal(envelope.next_action.ask_human, null);
    assert.ok(agentErrorSchema.safeParse(envelope).success);
  });
});
