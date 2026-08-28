import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUILTIN_ARCHETYPES,
  BUILTIN_ARCHETYPE_IDS,
  REGISTRY_VERSION,
} from "../src/archetypes/registry.js";

const EXPECTED_IDS = [
  "output_contract",
  "extraction_transform",
  "classification_route",
  "tool_call",
  "tool_result_use",
  "rag_retrieval",
  "grounded_answer",
  "citation_quality",
  "math_exact",
  "code_functional",
  "conversation_task",
  "agent_trajectory",
  "safety_policy",
  "fairness_invariance",
  "cost_latency_fit",
];

describe("archetype registry", () => {
  it("registers the V1 built-in ids once", () => {
    assert.equal(REGISTRY_VERSION, "evalrouter-archetypes-v1");
    assert.deepEqual([...BUILTIN_ARCHETYPE_IDS], EXPECTED_IDS);
    assert.equal(new Set(BUILTIN_ARCHETYPE_IDS).size, BUILTIN_ARCHETYPE_IDS.length);
  });

  it("defines required metadata for every built-in archetype", () => {
    for (const id of BUILTIN_ARCHETYPE_IDS) {
      const def = BUILTIN_ARCHETYPES[id];
      assert.equal(def.id, id);
      assert.ok(def.name.length > 0);
      assert.ok(def.measures.length > 0);
      assert.ok(def.appliesWhen.length > 0);
      assert.ok(def.requiredEvidence.length > 0);
      assert.ok(def.scorerPrimitives.length > 0);
      assert.ok(def.humanMarkPath.length > 0);
      assert.ok(def.examples.length > 0);
    }
  });

  it("keeps cost_latency_fit as a run-level archetype", () => {
    assert.equal(BUILTIN_ARCHETYPES.cost_latency_fit.draftable, false);
    assert.deepEqual(BUILTIN_ARCHETYPES.cost_latency_fit.scorerPrimitives, [
      "run_metric",
    ]);
  });
});
