import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapCiExit, type CiReport } from "../src/ci/exit.js";
import { ErrorCode } from "../src/tools/types.js";

function report(overrides: Partial<CiReport> = {}): CiReport {
  return {
    status: "succeeded",
    code: null,
    summary: { n_fail: 0, new_failures_missing_from_evals: false },
    eval_ids_not_scored: [],
    ...overrides,
  };
}

describe("ci_exit mapping (§13)", () => {
  it("returns 0 only on complete pass", () => {
    assert.equal(mapCiExit(report()), 0);
  });

  it("returns non-zero for any error code", () => {
    for (const code of [
      ErrorCode.need_new_model,
      ErrorCode.does_not_work,
      ErrorCode.evals_missing_new_failures,
      ErrorCode.need_more_evals,
      ErrorCode.COST_CAP_EXCEEDED,
      ErrorCode.NAMED_MODEL_MISMATCH,
      ErrorCode.COST_CAP_REQUIRED,
    ]) {
      assert.notEqual(mapCiExit(report({ code })), 0, code);
    }
  });

  it("returns non-zero while queued or running", () => {
    assert.notEqual(mapCiExit(report({ status: "queued" })), 0);
    assert.notEqual(mapCiExit(report({ status: "running" })), 0);
  });

  it("returns non-zero for partial or failed status", () => {
    assert.notEqual(mapCiExit(report({ status: "partial" })), 0);
    assert.notEqual(mapCiExit(report({ status: "failed" })), 0);
  });

  it("returns non-zero when evals failed even without code", () => {
    assert.notEqual(
      mapCiExit(report({ summary: { n_fail: 1, new_failures_missing_from_evals: false } })),
      0,
    );
  });

  it("returns non-zero when evals were not scored", () => {
    assert.notEqual(
      mapCiExit(report({ eval_ids_not_scored: ["cas_abc"] })),
      0,
    );
  });

  it("returns non-zero when new failures are missing from the set", () => {
    assert.notEqual(
      mapCiExit(
        report({
          summary: { n_fail: 0, new_failures_missing_from_evals: true },
        }),
      ),
      0,
    );
  });
});
