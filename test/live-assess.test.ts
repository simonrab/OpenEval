import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessLiveRequest } from "../src/live/assess.js";
import { CANARY_PERCENT } from "../src/live/sticky.js";
import {
  signPolicy,
  type SignedPolicy,
  type UnsignedPolicy,
} from "../src/policy.js";
import { idForCanaryBucket, p99Ms } from "./helpers/live-demo.js";

const sealKey = "assess-seal-key-not-a-secret";
const P99_SAMPLE_COUNT = 120;
const P99_BUDGET_MS = 5;

function unsigned(extra?: Partial<UnsignedPolicy>): UnsignedPolicy {
  return {
    policy_id: "pol_assess_full",
    version: 1,
    previous_policy_id: null,
    project_id: "prj_assess",
    rec_id: "rec_assess",
    ste_id: "ste_assess",
    compiled_at: "2026-08-26T12:00:00.000Z",
    primary: { model_id: "openai/gpt-4.1-mini", timeout_ms: 2500 },
    backups: [],
    canary: null,
    ...extra,
  };
}

function lastFull(): SignedPolicy {
  return signPolicy(sealKey, unsigned());
}

function canaryPolicy(): SignedPolicy {
  return signPolicy(
    sealKey,
    unsigned({
      policy_id: "pol_assess_canary",
      version: 2,
      previous_policy_id: "pol_assess_full",
      rec_id: "rec_assess_canary",
      primary: { model_id: "anthropic/claude-3-haiku", timeout_ms: 2500 },
    }),
  );
}

describe("Live assessment helper", () => {
  it("reads last full from memory when canary is off", () => {
    const full = lastFull();
    const picked = assessLiveRequest(
      { user_id: "u1" },
      { last_full: full, canary: null, canary_percent: 0 },
    );
    assert.equal(picked.policy_id, full.policy_id);
    assert.equal(picked.primary.model_id, "openai/gpt-4.1-mini");
  });

  it("hashes sticky id and picks canary when bucket is under 5", () => {
    const full = lastFull();
    const canary = canaryPolicy();
    const picked = assessLiveRequest(
      { user_id: idForCanaryBucket(true) },
      { last_full: full, canary, canary_percent: CANARY_PERCENT },
    );
    assert.equal(picked.policy_id, canary.policy_id);
  });

  it("hashes sticky id and keeps last full when bucket is 5 or more", () => {
    const full = lastFull();
    const canary = canaryPolicy();
    const picked = assessLiveRequest(
      { user_id: idForCanaryBucket(false) },
      { last_full: full, canary, canary_percent: CANARY_PERCENT },
    );
    assert.equal(picked.policy_id, full.policy_id);
  });

  it("keeps last full when both sticky ids are missing", () => {
    const full = lastFull();
    const canary = canaryPolicy();
    const picked = assessLiveRequest(
      {},
      { last_full: full, canary, canary_percent: CANARY_PERCENT },
    );
    assert.equal(picked.policy_id, full.policy_id);
  });

  it("does not treat a missing percent as 50", () => {
    const full = lastFull();
    const canary = canaryPolicy();
    const picked = assessLiveRequest(
      { user_id: idForCanaryBucket(true) },
      { last_full: full, canary, canary_percent: 0 },
    );
    assert.equal(picked.policy_id, full.policy_id);
  });

  it("p99 of policy pick plus sticky hash is 5 ms or less", () => {
    const cache = {
      last_full: lastFull(),
      canary: canaryPolicy(),
      canary_percent: CANARY_PERCENT,
    };
    const input = { user_id: idForCanaryBucket(true) };
    const samples: number[] = [];
    for (let i = 0; i < P99_SAMPLE_COUNT; i++) {
      const start = performance.now();
      const picked = assessLiveRequest(input, cache);
      samples.push(performance.now() - start);
      assert.equal(picked.policy_id, cache.canary.policy_id);
    }
    const addedP99 = p99Ms(samples);
    assert.ok(
      addedP99 <= P99_BUDGET_MS,
      `p99 added latency ${addedP99} ms exceeds ${P99_BUDGET_MS} ms`,
    );
  });
});
