import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateModelStats,
  applyHardLimits,
  pickNamedModel,
  type JobLimits,
  type RunResultRow,
} from "../src/rank.js";

function row(
  modelId: string,
  evalId: string,
  passed: boolean,
  timeMs: number,
  costUsd: number,
): RunResultRow {
  return {
    model_id: modelId,
    eval_id: evalId,
    passed,
    time_ms: timeMs,
    cost_usd: costUsd,
  };
}

describe("rank (J4)", () => {
  const evalIds = ["cas_a", "cas_b", "cas_c"];

  it("picks cheapest fast model among passers", () => {
    const results = [
      row("openai/gpt-4o-mini", "cas_a", true, 100, 0.02),
      row("openai/gpt-4o-mini", "cas_b", true, 120, 0.02),
      row("openai/gpt-4o-mini", "cas_c", true, 110, 0.02),
      row("anthropic/claude-3-haiku", "cas_a", true, 80, 0.08),
      row("anthropic/claude-3-haiku", "cas_b", true, 90, 0.08),
      row("anthropic/claude-3-haiku", "cas_c", true, 85, 0.08),
      row("google/gemini-flash-1.5", "cas_a", true, 200, 0.01),
      row("google/gemini-flash-1.5", "cas_b", true, 210, 0.01),
      row("google/gemini-flash-1.5", "cas_c", true, 205, 0.01),
    ];
    const stats = aggregateModelStats(results, evalIds);
    const picked = pickNamedModel(stats, null);
    assert.equal(picked.outcome, "named");
    if (picked.outcome === "named") {
      assert.equal(picked.winner, "google/gemini-flash-1.5");
      assert.ok(picked.backups.length <= 2);
      assert.ok(!picked.backups.includes(picked.winner));
    }
  });

  it("never names or backs up a model that failed evals", () => {
    const results = [
      row("openai/gpt-4o-mini", "cas_a", true, 50, 0.01),
      row("openai/gpt-4o-mini", "cas_b", false, 50, 0.01),
      row("openai/gpt-4o-mini", "cas_c", true, 50, 0.01),
      row("google/gemini-flash-1.5", "cas_a", true, 40, 0.005),
      row("google/gemini-flash-1.5", "cas_b", true, 40, 0.005),
      row("google/gemini-flash-1.5", "cas_c", true, 40, 0.005),
    ];
    const stats = aggregateModelStats(results, evalIds);
    const picked = pickNamedModel(stats, null);
    assert.equal(picked.outcome, "named");
    if (picked.outcome === "named") {
      assert.equal(picked.winner, "google/gemini-flash-1.5");
      assert.ok(!picked.backups.includes("openai/gpt-4o-mini"));
    }
  });

  it("drops models over max_wait_ms even when evals passed", () => {
    const results = [
      row("openai/gpt-4o-mini", "cas_a", true, 5000, 0.01),
      row("openai/gpt-4o-mini", "cas_b", true, 6000, 0.01),
      row("openai/gpt-4o-mini", "cas_c", true, 5500, 0.01),
      row("google/gemini-flash-1.5", "cas_a", true, 100, 0.02),
      row("google/gemini-flash-1.5", "cas_b", true, 120, 0.02),
      row("google/gemini-flash-1.5", "cas_c", true, 110, 0.02),
    ];
    const stats = aggregateModelStats(results, evalIds);
    const limited = applyHardLimits(stats, { max_wait_ms: 3000 });
    assert.ok(!limited.some((s) => s.modelId === "openai/gpt-4o-mini"));
    const picked = pickNamedModel(limited, { max_wait_ms: 3000 });
    assert.equal(picked.outcome, "named");
    if (picked.outcome === "named") {
      assert.equal(picked.winner, "google/gemini-flash-1.5");
    }
  });

  it("returns does_not_work when no model passes evals", () => {
    const results = [
      row("openai/gpt-4o-mini", "cas_a", false, 50, 0.01),
      row("openai/gpt-4o-mini", "cas_b", true, 50, 0.01),
      row("google/gemini-flash-1.5", "cas_a", true, 40, 0.005),
      row("google/gemini-flash-1.5", "cas_b", false, 40, 0.005),
    ];
    const stats = aggregateModelStats(results, ["cas_a", "cas_b"]);
    const picked = pickNamedModel(stats, null);
    assert.equal(picked.outcome, "does_not_work");
    if (picked.outcome === "does_not_work") {
      assert.ok(picked.failingEvalIds.length >= 1);
    }
  });

  it("respects allowed_models patterns", () => {
    const results = [
      row("openai/gpt-4o-mini", "cas_a", true, 50, 0.01),
      row("openai/gpt-4o-mini", "cas_b", true, 50, 0.01),
      row("google/gemini-flash-1.5", "cas_a", true, 40, 0.005),
      row("google/gemini-flash-1.5", "cas_b", true, 40, 0.005),
    ];
    const stats = aggregateModelStats(results, ["cas_a", "cas_b"]);
    const limited = applyHardLimits(stats, {
      allowed_models: ["google/*"],
    });
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.modelId, "google/gemini-flash-1.5");
  });

  it("respects excluded_models patterns", () => {
    const results = [
      row("openai/gpt-4o-mini", "cas_a", true, 50, 0.01),
      row("openai/gpt-4o-mini", "cas_b", true, 50, 0.01),
      row("google/gemini-flash-1.5", "cas_a", true, 40, 0.005),
      row("google/gemini-flash-1.5", "cas_b", true, 40, 0.005),
    ];
    const stats = aggregateModelStats(results, ["cas_a", "cas_b"]);
    const limited = applyHardLimits(stats, {
      excluded_models: ["openai/*"],
    });
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.modelId, "google/gemini-flash-1.5");
  });

  it("drops models without image support when needs_images is true", () => {
    const results = [
      row("meta-llama/llama-3.1-8b-instruct", "cas_a", true, 50, 0.01),
      row("meta-llama/llama-3.1-8b-instruct", "cas_b", true, 50, 0.01),
      row("openai/gpt-4o-mini", "cas_a", true, 60, 0.02),
      row("openai/gpt-4o-mini", "cas_b", true, 60, 0.02),
    ];
    const stats = aggregateModelStats(results, ["cas_a", "cas_b"]);
    const limited = applyHardLimits(stats, { needs_images: true });
    assert.ok(!limited.some((s) => s.modelId === "meta-llama/llama-3.1-8b-instruct"));
    assert.ok(limited.some((s) => s.modelId === "openai/gpt-4o-mini"));
  });
});
