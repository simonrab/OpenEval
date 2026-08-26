import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MUTATING_TOOLS,
  TOOL_NAMES,
  generateEvalSuiteInputSchema,
  generateEvalSuiteOutputSchema,
  getEvalReportInputSchema,
  getEvalReportOutputSchema,
  getLabelStatusInputSchema,
  getLabelStatusOutputSchema,
  parseToolInput,
  queueForLabelingInputSchema,
  queueForLabelingOutputSchema,
  recommendModelsInputSchema,
  recommendModelsOutputSchema,
  registerFailureInputSchema,
  registerFailureOutputSchema,
  runEvalsInputSchema,
  runEvalsOutputSchema,
  toolInputSchemas,
} from "../src/tools/schema.js";
import { ErrorCode } from "../src/tools/types.js";

const mutating = [
  "generate_eval_suite",
  "queue_for_labeling",
  "run_evals",
  "recommend_models",
  "register_failure",
  "compile_policy",
] as const;

const readOnly = ["get_label_status", "get_eval_report"] as const;

function validInput(name: (typeof TOOL_NAMES)[number]): Record<string, unknown> {
  switch (name) {
    case "generate_eval_suite":
      return {
        description: "Invoice image → JSON line items",
        idempotency_key: "idem-1",
      };
    case "queue_for_labeling":
      return {
        project_id: "prj_1",
        eval_set_id: "ste_1",
        idempotency_key: "idem-1",
      };
    case "get_label_status":
      return { project_id: "prj_1", eval_set_id: "ste_1" };
    case "run_evals":
      return {
        project_id: "prj_1",
        eval_set_id: "ste_1",
        max_eval_spend_usd: 2,
        idempotency_key: "idem-1",
      };
    case "recommend_models":
      return {
        project_id: "prj_1",
        eval_set_id: "ste_1",
        intent: "new_feature",
        idempotency_key: "idem-1",
      };
    case "register_failure":
      return {
        project_id: "prj_1",
        input: { prompt: "missing total_cents" },
        why_bad: "total_cents missing from JSON",
        idempotency_key: "idem-1",
      };
    case "get_eval_report":
      return { project_id: "prj_1", run_id: "run_1" };
    case "compile_policy":
      return {
        project_id: "prj_1",
        recommendation_id: "rec_1",
        eval_set_id: "ste_1",
        idempotency_key: "idem-1",
      };
  }
}

describe("tool schemas", () => {
  const v0Tools = [
    "generate_eval_suite",
    "queue_for_labeling",
    "get_label_status",
    "run_evals",
    "recommend_models",
    "register_failure",
    "get_eval_report",
  ] as const;

  it("registers the v0 seven tools and compile_policy", () => {
    for (const name of v0Tools) {
      assert.ok((TOOL_NAMES as readonly string[]).includes(name));
    }
    assert.ok((TOOL_NAMES as readonly string[]).includes("compile_policy"));
    assert.deepEqual([...TOOL_NAMES], [...v0Tools, "compile_policy"]);
    for (const name of TOOL_NAMES) {
      assert.ok(toolInputSchemas[name]);
    }
  });

  it("marks mutating tools that require idempotency_key", () => {
    assert.deepEqual([...MUTATING_TOOLS], [...mutating]);
  });
});

describe("additionalProperties: false", () => {
  for (const name of TOOL_NAMES) {
    it(`${name} rejects an extra input field`, () => {
      const parsed = parseToolInput(name, {
        ...validInput(name),
        unexpected_field: true,
      });
      assert.equal(parsed.ok, false);
      if (parsed.ok) {
        return;
      }
      assert.equal(parsed.error.code, ErrorCode.INVALID_INPUT);
      assert.ok(parsed.error.next_action);
    });
  }
});

describe("idempotency_key", () => {
  for (const name of mutating) {
    it(`${name} rejects a missing idempotency_key`, () => {
      const body = validInput(name);
      delete body.idempotency_key;
      const parsed = parseToolInput(name, body);
      assert.equal(parsed.ok, false);
      if (parsed.ok) {
        return;
      }
      assert.equal(parsed.error.code, ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
      assert.ok(parsed.error.next_action);
    });
  }

  for (const name of readOnly) {
    it(`${name} does not require idempotency_key`, () => {
      const parsed = parseToolInput(name, validInput(name));
      assert.equal(parsed.ok, true);
    });
  }
});

describe("input shapes", () => {
  it("accepts a valid generate_eval_suite body", () => {
    const parsed = generateEvalSuiteInputSchema.safeParse(validInput("generate_eval_suite"));
    assert.equal(parsed.success, true);
  });

  it("accepts generate_eval_suite with what_good_means and no description", () => {
    const parsed = generateEvalSuiteInputSchema.safeParse({
      what_good_means: {
        how_it_should_behave: "return JSON",
        success: "has line_items",
        must_never: "invent totals",
      },
      idempotency_key: "idem-1",
    });
    assert.equal(parsed.success, true);
  });

  it("requires eval_set_id when generate_eval_suite intent is add_feature", () => {
    const parsed = generateEvalSuiteInputSchema.safeParse({
      description: "add a field",
      intent: "add_feature",
      idempotency_key: "idem-1",
    });
    assert.equal(parsed.success, false);
  });

  it("allows retire_eval_ids without description when eval_set_id is set", () => {
    const parsed = generateEvalSuiteInputSchema.safeParse({
      eval_set_id: "ste_1",
      retire_eval_ids: ["cas_1"],
      idempotency_key: "idem-1",
    });
    assert.equal(parsed.success, true);
  });

  it("requires eval_set_id when retire_eval_ids is non-empty", () => {
    const parsed = generateEvalSuiteInputSchema.safeParse({
      retire_eval_ids: ["cas_1"],
      idempotency_key: "idem-1",
    });
    assert.equal(parsed.success, false);
  });

  it("requires project_id and eval_set_id on queue_for_labeling", () => {
    assert.equal(
      queueForLabelingInputSchema.safeParse({ idempotency_key: "idem-1" }).success,
      false,
    );
  });

  it("requires both ids on get_label_status", () => {
    assert.equal(
      getLabelStatusInputSchema.safeParse({ project_id: "prj_1" }).success,
      false,
    );
  });

  it("requires project_id, eval_set_id, and max_eval_spend_usd on run_evals", () => {
    assert.equal(
      runEvalsInputSchema.safeParse({
        project_id: "prj_1",
        eval_set_id: "ste_1",
        idempotency_key: "idem-1",
      }).success,
      false,
    );
  });

  it("requires intent on recommend_models", () => {
    assert.equal(
      recommendModelsInputSchema.safeParse({
        project_id: "prj_1",
        eval_set_id: "ste_1",
        idempotency_key: "idem-1",
      }).success,
      false,
    );
  });

  it("requires input on register_failure", () => {
    assert.equal(
      registerFailureInputSchema.safeParse({
        project_id: "prj_1",
        why_bad: "bad",
        idempotency_key: "idem-1",
      }).success,
      false,
    );
  });

  it("requires exactly one of run_id, recommendation_id, eval_set_id on get_eval_report", () => {
    assert.equal(
      getEvalReportInputSchema.safeParse({ project_id: "prj_1" }).success,
      false,
    );
    assert.equal(
      getEvalReportInputSchema.safeParse({
        project_id: "prj_1",
        run_id: "run_1",
        eval_set_id: "ste_1",
      }).success,
      false,
    );
    assert.equal(
      getEvalReportInputSchema.safeParse({
        project_id: "prj_1",
        run_id: "run_1",
      }).success,
      true,
    );
  });
});

describe("output schemas", () => {
  it("parses a generate_eval_suite success payload", () => {
    const parsed = generateEvalSuiteOutputSchema.safeParse({
      project_id: "prj_1",
      job_id: "job_1",
      eval_set_id: "ste_1",
      version: 1,
      evals: [
        {
          eval_id: "cas_1",
          title: "JSON has line_items[]",
          score_how: "code",
          status: "draft",
        },
      ],
      n_code: 8,
      n_person: 2,
      n_draft: 10,
      accept_url: "https://example.invalid/accept?token=signed",
      counts: {
        draft: 10,
        code: 8,
        needs_person: 2,
        trusted: 0,
        total: 10,
      },
      mark_url: null,
      next_action: {
        tool: null,
        args: {
          accept_url: "https://example.invalid/accept?token=signed",
          after_accept_tool: "queue_for_labeling",
        },
        ask_human: "open accept_url",
      },
    });
    assert.equal(parsed.success, true);
  });

  it("parses a queue_for_labeling success payload", () => {
    assert.equal(
      queueForLabelingOutputSchema.safeParse({
        n_queued: 2,
        mark_url: "https://example.invalid/mark",
        next_action: {
          tool: "get_label_status",
          args: { eval_set_id: "ste_1" },
          ask_human: "open mark_url",
        },
      }).success,
      true,
    );
  });

  it("parses a get_label_status success payload", () => {
    assert.equal(
      getLabelStatusOutputSchema.safeParse({
        counts: {
          draft: 3,
          code: 8,
          waiting_for_person: 2,
          trusted: 8,
          need_third_person: 0,
        },
        enough_trusted: true,
        mark_url: null,
        next_action: { tool: "run_evals", args: {}, ask_human: null },
      }).success,
      true,
    );
  });

  it("parses a run_evals immediate payload", () => {
    assert.equal(
      runEvalsOutputSchema.safeParse({
        run_id: "run_1",
        status: "queued",
        eta_s: 90,
        est_cost_usd: 0.8,
        next_action: {
          tool: "get_eval_report",
          args: { run_id: "run_1" },
          ask_human: null,
        },
      }).success,
      true,
    );
  });

  it("parses a recommend_models success payload", () => {
    assert.equal(
      recommendModelsOutputSchema.safeParse({
        recommendation_id: "rec_1",
        named_model: {
          id: "anthropic/claude-sonnet-4.6",
          backups: ["openai/gpt-4.1-mini"],
        },
        failing_eval_ids: [],
        quality: { n_pass: 27, n_fail: 3 },
        time_ms: { p50: 820, p95: 2100 },
        cost_usd: 0.42,
        report_url: "https://example.invalid/report",
        approve_url: "https://example.invalid/approve?token=signed",
        next_action: {
          tool: null,
          args: { approve_url: "https://example.invalid/approve?token=signed" },
          ask_human: "open approve_url",
        },
      }).success,
      true,
    );
  });

  it("parses a register_failure success payload", () => {
    assert.equal(
      registerFailureOutputSchema.safeParse({
        eval_id: "cas_2",
        eval_set_id: "ste_2",
        previous_eval_set_id: "ste_1",
        version: 4,
        score_how: "code",
        trusted: true,
        status: "draft",
        old_eval_ids: ["cas_1"],
        mark_url: null,
        next_action: { tool: "run_evals", args: {}, ask_human: null },
      }).success,
      true,
    );
  });

  it("parses a get_eval_report success payload with live_traffic_changed false", () => {
    assert.equal(
      getEvalReportOutputSchema.safeParse({
        status: "succeeded",
        code: null,
        summary: {
          run_id: "run_1",
          eval_set_id: "ste_1",
          eval_set_version: 3,
          n_pass: 27,
          n_fail: 6,
          time_ms: { p50: 820, p95: 2100 },
          cost_usd: 0.91,
          named_model_still_passes: true,
          new_failures_missing_from_evals: false,
          limits_ok: true,
        },
        named_model: { rec_id: "rec_1", model_id: "provider/model" },
        failing_eval_ids: [],
        eval_ids_scored: ["cas_1"],
        eval_ids_not_scored: [],
        models: [
          {
            model_id: "provider/model",
            n_pass: 1,
            n_fail: 0,
            failing_eval_ids: [],
          },
        ],
        items: [
          {
            eval_id: "cas_1",
            title: "JSON has total_cents",
            passed: false,
            reason_short: "field missing",
          },
        ],
        next_cursor: null,
        truncated: false,
        report_url: "https://example.invalid/report",
        live_traffic_changed: false,
        ci_exit: 0,
        next_action: { tool: "recommend_models", args: {}, ask_human: null },
      }).success,
      true,
    );
  });
});
