import { z } from "zod";
import {
  BUILTIN_ARCHETYPE_IDS,
  isCustomArchetypeId,
} from "../archetypes/registry.js";
import { agentError } from "../errors.js";
import {
  ErrorCode,
  nextActionSchema,
  type AgentError,
  type NextAction,
  type ToolName,
} from "./types.js";

export { TOOL_NAMES, isToolName } from "./types.js";
export type { ToolName } from "./types.js";

export const MUTATING_TOOLS = [
  "generate_eval_suite",
  "queue_for_labeling",
  "run_evals",
  "recommend_models",
  "register_failure",
  "compile_policy",
  "promote_live_sample",
  "propose_rollout",
  "configure_live_automation",
  "run_live_decision_cycle",
] as const satisfies readonly ToolName[];

function isMutating(name: ToolName): boolean {
  return (MUTATING_TOOLS as readonly string[]).includes(name);
}

const sampleFileSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .strict();

const labeledExampleSchema = z
  .object({
    text: z.string().min(1),
    label: z.string().min(1),
    expected: z
      .object({
        path: z.string().min(1),
        value: z.unknown(),
      })
      .strict(),
  })
  .strict();

const promptEvidenceSchema = z
  .object({
    name: z.string().optional(),
    text: z.string().min(1),
  })
  .strict();

const schemaEvidenceSchema = z
  .object({
    name: z.string().optional(),
    schema: z.record(z.unknown()).optional(),
    fields: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const hasSchema = val.schema != null && Object.keys(val.schema).length > 0;
    const hasFields = (val.fields?.length ?? 0) > 0;
    if (!hasSchema && !hasFields) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "schema or fields is required",
      });
    }
  });

const toolSchemaEvidenceSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    schema: z.record(z.unknown()).optional(),
  })
  .strict();

const sourceDocEvidenceSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

const traceSummaryEvidenceSchema = z
  .object({
    id: z.string().optional(),
    text: z.string().min(1),
    steps: z.array(z.string().min(1)).optional(),
  })
  .strict();

const evidenceSchema = z
  .object({
    prompts: z.array(promptEvidenceSchema).optional(),
    schemas: z.array(schemaEvidenceSchema).optional(),
    tool_schemas: z.array(toolSchemaEvidenceSchema).optional(),
    source_docs: z.array(sourceDocEvidenceSchema).optional(),
    trace_summaries: z.array(traceSummaryEvidenceSchema).optional(),
    user_notes: z.array(z.string().min(1)).optional(),
    labels: z.array(z.string().min(1)).optional(),
  })
  .strict();

const archetypeIdSchema = z
  .string()
  .min(1)
  .refine(
    (id) =>
      (BUILTIN_ARCHETYPE_IDS as readonly string[]).includes(id) ||
      isCustomArchetypeId(id),
    "archetype id must be built-in or start with custom:",
  );

const customArchetypeSchema = z
  .object({
    id: z.string().min(1).refine(isCustomArchetypeId, "id must start with custom:"),
    name: z.string().min(1),
    measures: z.string().min(1),
    applies_when: z.string().min(1),
    required_evidence: z.array(z.string().min(1)),
    scorer_primitives: z.array(z.string().min(1)),
    human_mark_path: z.string().min(1),
    examples: z.array(z.string().min(1)),
  })
  .strict();

const limitsSchema = z
  .object({
    needs_images: z.boolean().optional(),
    modalities: z.array(z.enum(["text", "image", "audio"])).optional(),
    max_wait_ms: z.number().optional(),
    max_spend_usd_per_1k: z.number().optional(),
    allowed_models: z.array(z.string()).optional(),
    excluded_models: z.array(z.string()).optional(),
  })
  .strict();

const whatGoodMeansSchema = z
  .object({
    how_it_should_behave: z.string(),
    success: z.string(),
    must_never: z.string(),
  })
  .strict();

export const generateEvalSuiteInputSchema = z
  .object({
    project_id: z.string().nullable().optional(),
    eval_set_id: z.string().nullable().optional(),
    intent: z.enum(["new_feature", "add_feature"]).optional(),
    description: z.string().optional(),
    sample_files: z.array(sampleFileSchema).optional(),
    labeled_examples: z.array(labeledExampleSchema).optional(),
    archetype_ids: z.array(archetypeIdSchema).optional(),
    custom_archetypes: z.array(customArchetypeSchema).optional(),
    evidence: evidenceSchema.optional(),
    system_prompt: z.string().min(1).optional(),
    limits: limitsSchema.optional(),
    what_good_means: whatGoodMeansSchema.nullable().optional(),
    size: z.enum(["smoke", "standard"]).optional(),
    retire_eval_ids: z.array(z.string()).optional(),
    idempotency_key: z.string().min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    const hasDescription =
      typeof val.description === "string" && val.description.length > 0;
    const hasGood = val.what_good_means != null;
    const hasLabeled = (val.labeled_examples?.length ?? 0) > 0;
    const hasArchetypes = (val.archetype_ids?.length ?? 0) > 0;
    const retiring = (val.retire_eval_ids?.length ?? 0) > 0;
    if (!hasDescription && !hasGood && !hasLabeled && !hasArchetypes && !retiring) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "description, what_good_means, labeled_examples, or archetype_ids is required",
      });
    }
    if (
      val.intent === "add_feature" &&
      (val.eval_set_id == null || val.eval_set_id === "")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eval_set_id"],
        message: "eval_set_id is required when intent is add_feature",
      });
    }
    if (retiring && (val.eval_set_id == null || val.eval_set_id === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eval_set_id"],
        message: "eval_set_id is required when retire_eval_ids is set",
      });
    }
  });

export const queueForLabelingInputSchema = z
  .object({
    project_id: z.string(),
    eval_set_id: z.string(),
    eval_ids: z.array(z.string()).nullable().optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();

export const getLabelStatusInputSchema = z
  .object({
    project_id: z.string(),
    eval_set_id: z.string(),
  })
  .strict();

const namedModelRefSchema = z
  .object({
    rec_id: z.string(),
    model_id: z.string(),
  })
  .strict();

const newFailureSchema = z
  .object({
    input: z.object({ prompt: z.string() }).strict(),
    trace: z.string().optional(),
  })
  .strict();

export const runEvalsInputSchema = z
  .object({
    project_id: z.string(),
    eval_set_id: z.string(),
    eval_set_version: z.number().int().nullable().optional(),
    models: z.array(z.string()).min(1).max(8).nullable().optional(),
    max_eval_spend_usd: z.number(),
    keys_ref: z.string().nullable().optional(),
    intent: z
      .enum(["new_feature", "add_feature", "after_failure", "recheck"])
      .nullable()
      .optional(),
    named_model: namedModelRefSchema.nullable().optional(),
    new_failures: z.array(newFailureSchema).optional(),
    idempotency_key: z.string().min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.intent === "recheck" && val.named_model == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["named_model"],
        message: "named_model is required when intent is recheck",
      });
    }
  });

export const recommendModelsInputSchema = z
  .object({
    project_id: z.string(),
    eval_set_id: z.string(),
    run_id: z.string().optional(),
    intent: z.enum(["new_feature", "add_feature", "after_failure", "recheck"]),
    current_named_model: z.string().nullable().optional(),
    idempotency_key: z.string().min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (
      (val.intent === "after_failure" || val.intent === "recheck") &&
      (val.current_named_model == null || val.current_named_model === "")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["current_named_model"],
        message:
          "current_named_model is required when intent is after_failure or recheck",
      });
    }
  });

export const programCheckSchema = z
  .object({
    kind: z.enum([
      "json_valid",
      "tool_name",
      "field_equals",
      "must_not_contain",
      "fixture",
      "json_schema",
      "regex_match",
      "numeric_close",
      "set_equals",
      "tool_args",
      "trace_rule",
      "citation_support",
      "retrieval_contains",
      "pairwise_equals",
    ]),
    expected: z.unknown(),
  })
  .strict();

export const registerFailureInputSchema = z
  .object({
    project_id: z.string(),
    eval_set_id: z.string().optional(),
    input: z
      .object({
        prompt: z.string(),
        files: z
          .array(
            z.object({ path: z.string(), content: z.string().optional() }).strict(),
          )
          .optional(),
      })
      .strict(),
    output: z.record(z.unknown()).optional(),
    why_bad: z.string().optional(),
    trace: z.string().optional(),
    program_check: programCheckSchema.optional(),
    archetype_id: archetypeIdSchema.optional(),
    evidence: evidenceSchema.optional(),
    current_named_model: z.string().nullable().optional(),
    idempotency_key: z.string().min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    const hasWhy = typeof val.why_bad === "string" && val.why_bad.length > 0;
    const hasPrompt =
      typeof val.input.prompt === "string" && val.input.prompt.length > 0;
    if (!hasWhy && !hasPrompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "why_bad or input.prompt is required",
      });
    }
  });

export const compilePolicyInputSchema = z
  .object({
    project_id: z.string().min(1),
    recommendation_id: z.string().min(1),
    eval_set_id: z.string().min(1),
    idempotency_key: z.string().min(1),
  })
  .strict();

export const promoteLiveSampleInputSchema = z
  .object({
    project_id: z.string().min(1),
    sample_id: z.string().regex(/^smp_/),
    program_check: programCheckSchema.optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();

export const proposeRolloutInputSchema = z
  .object({
    project_id: z.string().min(1),
    intent: z.enum(["canary", "full", "rollback"]),
    idempotency_key: z.string().min(1),
  })
  .strict();

export const getLiveReportInputSchema = z
  .object({
    project_id: z.string().min(1),
    cursor: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

const automationGuardRulesSchema = z
  .object({
    auto_canary: z.boolean().optional(),
    auto_full: z.boolean().optional(),
    auto_rollback: z.boolean().optional(),
    allowed_models: z.array(z.string()).optional(),
    max_eval_spend_usd: z.number().min(0).optional(),
    min_eval_pass_rate: z.number().min(0).max(1).optional(),
    max_fallback_rate: z.number().min(0).max(1).optional(),
    max_miss_rate: z.number().min(0).max(1).optional(),
    min_canary_age_s: z.number().int().min(0).optional(),
    min_canary_requests: z.number().int().min(0).optional(),
    sample_flood_limit: z.number().int().min(0).optional(),
    expires_at: z.string().nullable().optional(),
    kill_switch: z.boolean().optional(),
    frozen: z.boolean().optional(),
  })
  .strict();

export const configureLiveAutomationInputSchema = z
  .object({
    project_id: z.string().min(1),
    mode: z.enum(["manual", "guarded"]),
    guard_rules: automationGuardRulesSchema.optional(),
    approved_by: z.string().min(1).nullable().optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();

export const runLiveDecisionCycleInputSchema = z
  .object({
    project_id: z.string().min(1),
    idempotency_key: z.string().min(1),
  })
  .strict();

export const getDecisionCycleStatusInputSchema = z
  .object({
    project_id: z.string().min(1),
    cycle_id: z.string().nullable().optional(),
  })
  .strict();

export const getEvalReportInputSchema = z
  .object({
    project_id: z.string(),
    run_id: z.string().nullable().optional(),
    recommendation_id: z.string().nullable().optional(),
    eval_set_id: z.string().nullable().optional(),
    cursor: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const count = [val.run_id, val.recommendation_id, val.eval_set_id].filter(
      (v) => typeof v === "string" && v.length > 0,
    ).length;
    if (count !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of run_id, recommendation_id, eval_set_id is required",
      });
    }
  });

const evalPreviewSchema = z
  .object({
    eval_id: z.string(),
    title: z.string(),
    score_how: z.enum(["code", "person"]),
    status: z.string(),
    archetype_id: z.string().nullable(),
    scorer_primitive: z.string().nullable(),
  })
  .strict();

export const generateEvalSuiteOutputSchema = z
  .object({
    project_id: z.string(),
    job_id: z.string(),
    eval_set_id: z.string(),
    version: z.number().int(),
    evals: z.array(evalPreviewSchema),
    n_code: z.number().int(),
    n_person: z.number().int(),
    n_draft: z.number().int(),
    registry_version: z.string(),
    archetype_ids_used: z.array(z.string()),
    counts: z
      .object({
        draft: z.number().int(),
        code: z.number().int(),
        needs_person: z.number().int(),
        trusted: z.number().int(),
        total: z.number().int(),
      })
      .strict(),
    accept_url: z.string().nullable(),
    mark_url: z.string().nullable(),
    next_action: nextActionSchema,
  })
  .strict();

export const queueForLabelingOutputSchema = z
  .object({
    n_queued: z.number().int(),
    mark_url: z.string().nullable(),
    next_action: nextActionSchema,
  })
  .strict();

export const getLabelStatusOutputSchema = z
  .object({
    counts: z
      .object({
        draft: z.number().int(),
        code: z.number().int(),
        waiting_for_person: z.number().int(),
        trusted: z.number().int(),
        need_third_person: z.number().int(),
      })
      .strict(),
    enough_trusted: z.boolean(),
    mark_url: z.string().nullable(),
    next_action: nextActionSchema,
  })
  .strict();

export const runEvalsOutputSchema = z
  .object({
    run_id: z.string(),
    status: z.enum(["queued", "running"]),
    eta_s: z.number(),
    est_cost_usd: z.number(),
    next_action: nextActionSchema,
  })
  .strict();

export const recommendModelsOutputSchema = z
  .object({
    recommendation_id: z.string(),
    named_model: z
      .object({
        id: z.string(),
        backups: z.array(z.string()).max(2),
      })
      .strict()
      .nullable(),
    failing_eval_ids: z.array(z.string()),
    quality: z
      .object({
        n_pass: z.number().int(),
        n_fail: z.number().int(),
      })
      .strict(),
    time_ms: z
      .object({
        p50: z.number(),
        p95: z.number(),
      })
      .strict(),
    cost_usd: z.number(),
    report_url: z.string(),
    approve_url: z.string(),
    next_action: nextActionSchema,
  })
  .strict();

export const registerFailureOutputSchema = z
  .object({
    eval_id: z.string(),
    eval_set_id: z.string(),
    previous_eval_set_id: z.string(),
    version: z.number().int(),
    score_how: z.enum(["code", "person"]),
    trusted: z.boolean(),
    status: z.string(),
    old_eval_ids: z.array(z.string()),
    mark_url: z.string().nullable(),
    next_action: nextActionSchema,
  })
  .strict();

export const getEvalReportOutputSchema = z
  .object({
    status: z.enum(["queued", "running", "succeeded", "partial", "failed"]),
    code: z
      .enum([
        "need_new_model",
        "does_not_work",
        "evals_missing_new_failures",
        "need_more_evals",
        "COST_CAP_EXCEEDED",
      ])
      .nullable(),
    summary: z
      .object({
        run_id: z.string(),
        eval_set_id: z.string(),
        eval_set_version: z.number().int(),
        n_pass: z.number().int(),
        n_fail: z.number().int(),
        time_ms: z
          .object({
            p50: z.number(),
            p95: z.number(),
          })
          .strict(),
        cost_usd: z.number(),
        named_model_still_passes: z.boolean().nullable(),
        new_failures_missing_from_evals: z.boolean(),
        limits_ok: z.boolean(),
      })
      .strict(),
    named_model: namedModelRefSchema.nullable(),
    failing_eval_ids: z.array(z.string()),
    eval_ids_scored: z.array(z.string()),
    eval_ids_not_scored: z.array(z.string()),
    models: z.array(
      z
        .object({
          model_id: z.string(),
          n_pass: z.number().int(),
          n_fail: z.number().int(),
          failing_eval_ids: z.array(z.string()),
        })
        .strict(),
    ),
    items: z.array(
      z
        .object({
          eval_id: z.string(),
          title: z.string(),
          passed: z.boolean(),
          reason_short: z.string(),
          archetype_id: z.string().nullable(),
          scorer_primitive: z.string().nullable(),
        })
        .strict(),
    ),
    next_cursor: z.string().nullable(),
    truncated: z.boolean(),
    report_url: z.string(),
    live_traffic_changed: z.literal(false),
    ci_exit: z.number().int(),
    next_action: nextActionSchema,
  })
  .strict();

export const compilePolicyOutputSchema = z
  .object({
    policy_id: z.string(),
    approve_url: z.string(),
    live_traffic_changed: z.literal(false),
    next_action: nextActionSchema,
  })
  .strict();

export const promoteLiveSampleOutputSchema = z
  .object({
    eval_id: z.string(),
    eval_set_id: z.string(),
    previous_eval_set_id: z.string(),
    version: z.number().int(),
    score_how: z.enum(["code", "person"]),
    trusted: z.boolean(),
    status: z.string(),
    old_eval_ids: z.array(z.string()),
    mark_url: z.string().nullable(),
    sample_url: z.string(),
    live_traffic_changed: z.literal(false),
    next_action: nextActionSchema,
  })
  .strict();

export const proposeRolloutOutputSchema = z
  .object({
    rollout_id: z.string(),
    approve_url: z.string(),
    live_traffic_changed: z.literal(false),
    next_action: nextActionSchema,
  })
  .strict();

export const getLiveReportOutputSchema = z
  .object({
    policy_id: z.string().nullable(),
    canary: z.boolean(),
    intended_split: z.number(),
    observed_split: z.number(),
    fallback_rate: z.number(),
    sample_counts: z
      .object({
        stored: z.number().int(),
        dropped: z.number().int(),
        pii_blocked: z.number().int(),
      })
      .strict(),
    last_known_age_s: z.number().int().nullable(),
    samples: z.array(
      z
        .object({
          sample_id: z.string(),
          why: z.enum(["vendor_error", "timeout", "app_reported"]),
          input_redacted: z.string(),
          output_redacted: z.string(),
        })
        .strict(),
    ),
    next_cursor: z.string().nullable(),
    truncated: z.boolean(),
    report_url: z.string(),
    automation_mode: z.enum(["manual", "guarded"]),
    last_cycle: z
      .object({
        cycle_id: z.string(),
        status: z.enum(["succeeded", "blocked"]),
        finished_at: z.string(),
      })
      .strict()
      .nullable(),
    pending_action: z.string().nullable(),
    blocked_reason: z.string().nullable(),
    decision_ids: z.array(z.string()),
    audit_ids: z.array(z.string()),
    live_traffic_changed: z.literal(false),
    next_action: nextActionSchema,
  })
  .strict();

export const configureLiveAutomationOutputSchema = z
  .object({
    automation_id: z.string(),
    automation_mode: z.enum(["manual", "guarded"]),
    guard_rules: z.record(z.unknown()),
    audit_ids: z.array(z.string()),
    live_traffic_changed: z.literal(false),
    next_action: nextActionSchema,
  })
  .strict();

export const decisionCycleOutputSchema = z
  .object({
    cycle_id: z.string().nullable(),
    status: z.enum(["succeeded", "blocked"]),
    automation_mode: z.enum(["manual", "guarded"]),
    pending_action: z.string().nullable(),
    blocked_reason: z.string().nullable(),
    decision_ids: z.array(z.string()),
    audit_ids: z.array(z.string()),
    live_traffic_changed: z.boolean(),
    next_action: nextActionSchema,
  })
  .strict();

export const toolInputSchemas: Record<ToolName, z.ZodType> = {
  generate_eval_suite: generateEvalSuiteInputSchema,
  queue_for_labeling: queueForLabelingInputSchema,
  get_label_status: getLabelStatusInputSchema,
  run_evals: runEvalsInputSchema,
  recommend_models: recommendModelsInputSchema,
  register_failure: registerFailureInputSchema,
  get_eval_report: getEvalReportInputSchema,
  compile_policy: compilePolicyInputSchema,
  get_live_report: getLiveReportInputSchema,
  promote_live_sample: promoteLiveSampleInputSchema,
  propose_rollout: proposeRolloutInputSchema,
  configure_live_automation: configureLiveAutomationInputSchema,
  run_live_decision_cycle: runLiveDecisionCycleInputSchema,
  get_decision_cycle_status: getDecisionCycleStatusInputSchema,
};

export type ParseToolInputResult =
  | { ok: true; data: unknown }
  | { ok: false; error: AgentError };

function formatZodError(err: z.ZodError): string {
  const unrecognized = err.issues.find((issue) => issue.code === "unrecognized_keys");
  if (unrecognized && unrecognized.code === "unrecognized_keys") {
    return `Unexpected field: ${unrecognized.keys.join(", ")}`;
  }
  const first = err.issues[0];
  if (!first) {
    return "Invalid input";
  }
  const path = first.path.join(".");
  return path ? `${path}: ${first.message}` : first.message;
}

function retryNextAction(tool: ToolName): NextAction {
  return { tool, args: {}, ask_human: null };
}

export function parseToolInput(
  name: ToolName,
  body: unknown,
): ParseToolInputResult {
  if (isMutating(name)) {
    const key =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as { idempotency_key?: unknown }).idempotency_key
        : undefined;
    if (typeof key !== "string" || key.length === 0) {
      return {
        ok: false,
        error: agentError({
          code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
          message: "idempotency_key is required for mutating calls",
          retryable: true,
          suggested_tool: name,
          suggested_args: {},
          next_action: retryNextAction(name),
        }),
      };
    }
  }

  const parsed = toolInputSchemas[name].safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: agentError({
        code: ErrorCode.INVALID_INPUT,
        message: formatZodError(parsed.error),
        retryable: true,
        suggested_tool: name,
        suggested_args: {},
        next_action: retryNextAction(name),
      }),
    };
  }
  return { ok: true, data: parsed.data };
}
