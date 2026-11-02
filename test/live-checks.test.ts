import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MemberEval } from "../src/eval-set.js";
import { deriveLiveChecks, runLiveChecks } from "../src/live/checks.js";
import { canaryHealthReason, clearlyHigher, type ArmStats } from "../src/live/arms.js";

function member(extra: Partial<MemberEval>): MemberEval {
  return {
    eval_id: "ev_1",
    title: "t",
    score_how: "code",
    status: "trusted",
    program_check: { kind: "json_valid", expected: true },
    input_truncated: "in",
    form_spec: null,
    archetype_id: "output_contract",
    scorer_primitive: null,
    evidence_json: null,
    ...extra,
  } as MemberEval;
}

describe("live checks", () => {
  it("keeps only trusted contract and safety checks that fit any answer", () => {
    const checks = deriveLiveChecks([
      member({}),
      member({ eval_id: "dup" }),
      member({ eval_id: "safety", archetype_id: "safety_policy", program_check: { kind: "must_not_contain", expected: "SSN" } }),
      member({ eval_id: "draft", status: "draft", program_check: { kind: "length_range", expected: { max: 5 } } }),
      member({ eval_id: "route", archetype_id: "classification_route", program_check: { kind: "json_schema", expected: {} } }),
      member({ eval_id: "field", program_check: { kind: "field_equals", expected: { path: "a", value: 1 } } }),
      member({ eval_id: "invalid", program_check: { kind: "json_valid", expected: false } }),
    ]);
    assert.deepEqual(checks, [
      { kind: "json_valid", expected: true },
      { kind: "must_not_contain", expected: "SSN" },
    ]);
  });

  it("runs checks and reports failures", () => {
    const checks = [
      { kind: "json_valid" as const, expected: true },
      { kind: "must_not_contain" as const, expected: "secret" },
    ];
    assert.deepEqual(runLiveChecks('{"ok":true}', checks), { checked: true, failed: [] });
    const bad = runLiveChecks("secret text", checks);
    assert.equal(bad.checked, true);
    assert.equal(bad.failed.length, 2);
    assert.deepEqual(runLiveChecks("anything", []), { checked: false, failed: [] });
  });
});

function stats(extra: Partial<ArmStats>): ArmStats {
  const s: ArmStats = {
    policy_id: "pol",
    since: "2026-11-01T00:00:00.000Z",
    request_count: 0,
    fallback_count: 0,
    error_count: 0,
    miss_count: 0,
    quality_checked: 0,
    quality_failed: 0,
    latency_count: 0,
    cost_count: 0,
    fallback_rate: null,
    error_rate: null,
    miss_rate: null,
    quality_fail_rate: null,
    avg_latency_ms: null,
    avg_cost_usd: null,
    ...extra,
  };
  const rate = (k: number, n: number) => (n > 0 ? k / n : null);
  s.fallback_rate = rate(s.fallback_count, s.request_count);
  s.error_rate = rate(s.error_count, s.request_count);
  s.miss_rate = rate(s.miss_count, s.request_count);
  s.quality_fail_rate = rate(s.quality_failed, s.quality_checked);
  return s;
}

const limits = {
  max_fallback_rate: 0.2,
  max_error_rate: 0.2,
  max_miss_rate: 0.2,
  max_quality_fail_rate: 0.5,
  max_rate_increase: 0.02,
  max_latency_increase: 0.5,
  max_cost_increase: 0.5,
  min_rollback_requests: 20,
};

describe("canary health", () => {
  it("needs a clear gap, not just a higher rate", () => {
    assert.equal(clearlyHigher(3, 100, 2, 100, 0.02), false, "1 point is inside the margin");
    assert.equal(clearlyHigher(6, 100, 2, 100, 0.02), false, "4 points on 100 requests is noise");
    assert.equal(clearlyHigher(60, 1000, 20, 1000, 0.02), true);
    assert.equal(clearlyHigher(5, 0, 0, 100, 0.02), false);
  });

  it("compares the canary with the full policy", () => {
    const control = stats({ request_count: 2000, error_count: 20 });
    const worse = stats({ request_count: 500, error_count: 50 });
    assert.equal(canaryHealthReason(worse, control, limits), "error_rate_worse");
    const same = stats({ request_count: 500, error_count: 5 });
    assert.equal(canaryHealthReason(same, control, limits), null);
  });

  it("waits for enough canary traffic", () => {
    const control = stats({ request_count: 2000 });
    const tiny = stats({ request_count: 5, error_count: 5 });
    assert.equal(canaryHealthReason(tiny, control, limits), null);
  });
});
