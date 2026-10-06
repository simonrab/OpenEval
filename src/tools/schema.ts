import { z } from "zod";
import {
  BUILTIN_ARCHETYPE_IDS,
  isCustomArchetypeId,
} from "../archetypes/registry.js";
import { agentError } from "../errors.js";
import { REGEX_MAX_PATTERN_CHARS, unsafeRegexReason } from "../scoring/primitives.js";
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
  "submit_outputs",
  "configure_judge",
  "calibrate_judge",
] as const satisfies readonly ToolName[];

function isMutating(name: ToolName): boolean {
  return (MUTATING_TOOLS as readonly string[]).includes(name);
}

/** get_verdict writes a round only when it has a session_id. */
function needsIdempotencyKey(name: ToolName, body: unknown): boolean {
  if (isMutating(name)) {
    return true;
  }
  if (name === "get_verdict" && body !== null && typeof body === "object") {
    const sessionId = (body as { session_id?: unknown }).session_id;
    return typeof sessionId === "string" && sessionId.length > 0;
  }
  return false;
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

/** An output that people mark on the mark screen. A judge calibrates on these marks. */
const markOutputSchema = z
  .object({
    eval_id: z.string().min(1),
    output: z.string().min(1).max(20_000),
  })
  .strict();

export const queueForLabelingInputSchema = z
  .object({
    project_id: z.string(),
    eval_set_id: z.string(),
    eval_ids: z.array(z.string()).nullable().optional(),
    outputs: z.array(markOutputSchema).max(500).optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();

export const getLabelStatusInputSchema = z
  .object({
    project_id: z.string(),
    eval_set_id: z.string(),
  })
  .strict();

const costSourceSchema = z.enum(["provider", "estimate", "caller", "mixed"]);

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

export const modelSettingsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().min(1).optional(),
    reasoning_effort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  })
  .strict();

/** One setup to score. id is `model` or `model#label`. */
export const candidateSchema = z
  .object({
    id: z.string().min(1).regex(/^[^#]+(#[A-Za-z0-9._-]+)?$/),
    model: z.string().min(1),
    settings: modelSettingsSchema.optional(),
    system_prompt: z.string().min(1).optional(),
  })
  .strict()
  .refine((c) => c.id.split("#")[0] === c.model, {
    message: "candidate id must be the model id, or model#label",
    path: ["id"],
  });

export const runEvalsInputSchema = z
  .object({
    project_id: z.string(),
    eval_set_id: z.string(),
    eval_set_version: z.number().int().nullable().optional(),
    models: z.array(z.string()).min(1).max(8).nullable().optional(),
    candidates: z.array(candidateSchema).min(1).max(8).optional(),
    reps: z.number().int().min(1).max(10).optional(),
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
    if (val.candidates && val.models && val.models.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates"],
        message: "pass models or candidates, not both",
      });
    }
    if (val.candidates) {
      const ids = val.candidates.map((c) => c.id);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates"],
          message: "candidate ids must be unique",
        });
      }
    }
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

const jsonPathSchema = z.string().min(1).max(200);

const regexMatchExpectedSchema = z.union([
  z.string().min(1).max(REGEX_MAX_PATTERN_CHARS),
  z
    .object({
      pattern: z.string().min(1).max(REGEX_MAX_PATTERN_CHARS),
      flags: z.string().regex(/^[imsu]*$/).optional(),
      path: jsonPathSchema.optional(),
      negate: z.boolean().optional(),
    })
    .strict(),
]);

const numericCloseExpectedSchema = z
  .object({
    path: jsonPathSchema.optional(),
    value: z.number().finite(),
    abs_tol: z.number().min(0).optional(),
    rel_tol: z.number().min(0).max(1).optional(),
    tolerance: z.number().min(0).optional(),
  })
  .strict();

const setEqualsExpectedSchema = z
  .object({
    path: jsonPathSchema.optional(),
    values: z.array(z.unknown()).max(500),
    ignore_order: z.boolean().optional(),
    order_matters: z.boolean().optional(),
    case_insensitive: z.boolean().optional(),
  })
  .strict();

const containsExpectedSchema = z
  .object({
    values: z.array(z.string().min(1).max(500)).min(1).max(100),
    case_insensitive: z.boolean().optional(),
  })
  .strict();

const lengthRangeExpectedSchema = z
  .object({
    min_chars: z.number().int().min(0).optional(),
    max_chars: z.number().int().min(0).optional(),
    min_words: z.number().int().min(0).optional(),
    max_words: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.min_chars != null || v.max_chars != null || v.min_words != null || v.max_words != null,
    "set a min or max",
  )
  .refine(
    (v) =>
      (v.min_chars == null || v.max_chars == null || v.min_chars <= v.max_chars) &&
      (v.min_words == null || v.max_words == null || v.min_words <= v.max_words),
    "min must not be more than max",
  );

const jsonSchemaExpectedSchema = z.record(z.unknown());

/** Kinds with a known expected shape. Other kinds accept any expected value. */
const expectedSchemas: Partial<Record<string, z.ZodType>> = {
  regex_match: regexMatchExpectedSchema,
  numeric_close: numericCloseExpectedSchema,
  set_equals: setEqualsExpectedSchema,
  contains_all: containsExpectedSchema,
  contains_any: containsExpectedSchema,
  length_range: lengthRangeExpectedSchema,
  json_schema: jsonSchemaExpectedSchema,
};

export const PROGRAM_CHECK_KINDS = [
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
  "contains_all",
  "contains_any",
  "length_range",
] as const;

export const programCheckSchema = z
  .object({
    kind: z.enum(PROGRAM_CHECK_KINDS),
    expected: z.unknown(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const schema = expectedSchemas[val.kind];
    if (!schema) {
      return;
    }
    const parsed = schema.safeParse(val.expected);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected", ...(first?.path ?? [])],
        message: first?.message ?? `bad ${val.kind} expected`,
      });
      return;
    }
    if (val.kind === "regex_match") {
      const spec =
        typeof val.expected === "string"
          ? { pattern: val.expected }
          : (val.expected as { pattern: string; flags?: string });
      const unsafe = unsafeRegexReason(spec.pattern, spec.flags);
      if (unsafe) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expected", "pattern"],
          message: `regex is not allowed: ${unsafe}`,
        });
      }
    }
  });

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
    min_pass_rate_low: z.number().min(0).max(1).nullable().optional(),
    require_provider_cost: z.boolean().optional(),
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

export const getTrainingFailuresInputSchema = z
  .object({
    project_id: z.string().min(1),
    run_id: z.string().min(1),
    candidate_id: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
    cursor: z.string().nullable().optional(),
  })
  .strict();

export const getVerdictInputSchema = z
  .object({
    project_id: z.string().min(1),
    baseline_run_id: z.string().min(1),
    baseline_candidate_id: z.string().min(1),
    candidate_run_id: z.string().min(1),
    candidate_id: z.string().min(1),
    objective: z.enum(["quality", "cost"]).optional(),
    session_id: z.string().min(1).max(128).optional(),
    min_effect: z.number().gt(0).max(1).optional(),
    idempotency_key: z.string().min(1).optional(),
  })
  .strict();

export const getEvalInputsInputSchema = z
  .object({
    project_id: z.string().min(1),
    eval_set_id: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().nullable().optional(),
  })
  .strict();

/** The most outputs in one submit_outputs call. */
export const MAX_SUBMIT_OUTPUTS = 2000;
export const MAX_OUTPUT_CHARS = 200_000;

/** A harness setup. id is free form, e.g. `harness` or `harness#label`. */
export const harnessCandidateSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._/:-]+(#[A-Za-z0-9._-]+)?$/, {
        message: "candidate id must be a name, or name#label, with no spaces",
      }),
    label: z.string().min(1).max(128).optional(),
    description: z.string().min(1).max(1000).optional(),
    commit: z.string().min(1).max(128).optional(),
  })
  .strict();

const harnessOutputSchema = z
  .object({
    eval_id: z.string().min(1),
    rep: z.number().int().min(0).max(9).optional(),
    output: z.string().max(MAX_OUTPUT_CHARS).optional(),
    error: z.string().min(1).max(2000).optional(),
    time_ms: z.number().min(0).optional(),
    cost_usd: z.number().min(0).optional(),
    prompt_tokens: z.number().int().min(0).optional(),
    completion_tokens: z.number().int().min(0).optional(),
    served_model: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((o) => (o.output === undefined) !== (o.error === undefined), {
    message: "pass output or error, not both",
  });

export const submitOutputsInputSchema = z
  .object({
    project_id: z.string().min(1),
    eval_set_id: z.string().min(1),
    candidate: harnessCandidateSchema,
    outputs: z.array(harnessOutputSchema).min(1).max(MAX_SUBMIT_OUTPUTS),
    keys_ref: z.string().min(1).nullable().optional(),
    max_eval_spend_usd: z.number().min(0).optional(),
    idempotency_key: z.string().min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.keys_ref && !(val.max_eval_spend_usd != null && val.max_eval_spend_usd > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_eval_spend_usd"],
        message: "max_eval_spend_usd must be more than 0 when keys_ref is set",
      });
    }
  });

export const configureJudgeInputSchema = z
  .object({
    project_id: z.string().min(1),
    eval_set_id: z.string().min(1),
    judge_model: z.string().min(1).max(200),
    rubric: z.string().min(1).max(8000).optional(),
    settings: modelSettingsSchema.optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();

export const calibrateJudgeInputSchema = z
  .object({
    project_id: z.string().min(1),
    eval_set_id: z.string().min(1),
    keys_ref: z.string().min(1).nullable().optional(),
    max_eval_spend_usd: z.number(),
    idempotency_key: z.string().min(1),
  })
  .strict();

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
    n_outputs_shown: z.number().int().optional(),
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
        candidate: candidateSchema.optional(),
      })
      .strict()
      .nullable(),
    failing_eval_ids: z.array(z.string()),
    quality: z
      .object({
        n_pass: z.number().int(),
        n_fail: z.number().int(),
        n_trials: z.number().int().optional(),
        pass_rate: z.number().optional(),
        pass_rate_ci95: z.tuple([z.number(), z.number()]).optional(),
        flaky_eval_ids: z.array(z.string()).optional(),
      })
      .strict(),
    time_ms: z
      .object({
        p50: z.number(),
        p95: z.number(),
      })
      .strict(),
    cost_usd: z.number(),
    cost_source: costSourceSchema.optional(),
    n_person_evals_not_graded: z.number().int(),
    grader_advice: z.string().nullable(),
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
        n_person_evals_not_graded: z.number().int(),
        grader_advice: z.string().nullable(),
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
          n_trials: z.number().int().optional(),
          pass_rate: z.number().optional(),
          pass_rate_ci95: z.tuple([z.number(), z.number()]).optional(),
          flaky_eval_ids: z.array(z.string()).optional(),
          error_eval_ids: z.array(z.string()).optional(),
          cost_usd: z.number().optional(),
          cost_source: costSourceSchema.optional(),
          spend_per_1k_tokens_usd: z.number().optional(),
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
    report_url: z.string().nullable(),
    holdout_redacted: z
      .object({
        n_evals: z.number().int(),
        n_pass: z.number().int(),
        n_fail: z.number().int(),
      })
      .strict()
      .optional(),
    live_traffic_changed: z.literal(false),
    ci_exit: z.number().int(),
    next_action: nextActionSchema,
  })
  .strict();

export const compilePolicyOutputSchema = z
  .object({
    policy_id: z.string(),
    format: z.number().int(),
    primary: z
      .object({
        candidate_id: z.string(),
        model_id: z.string(),
        settings: modelSettingsSchema.nullable(),
        has_system_prompt: z.boolean(),
      })
      .strict(),
    system_prompt_note: z.string().nullable(),
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
    from_candidate_id: z.string().nullable(),
    to_candidate_id: z.string().nullable(),
    live_traffic_changed: z.literal(false),
    next_action: nextActionSchema,
  })
  .strict();

export const getLiveReportOutputSchema = z
  .object({
    policy_id: z.string().nullable(),
    candidate_id: z.string().nullable(),
    canary: z.boolean(),
    canary_candidate_id: z.string().nullable(),
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
          candidate_id: z.string().nullable(),
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

const trainingFailureRepSchema = z
  .object({
    rep: z.number().int(),
    passed: z.boolean(),
    reason_short: z.string(),
    output: z.string().nullable(),
  })
  .strict();

export const getTrainingFailuresOutputSchema = z
  .object({
    run_id: z.string(),
    candidate_id: z.string(),
    eval_set_id: z.string(),
    directional: z.boolean(),
    train: z
      .object({
        n_evals: z.number().int(),
        n_pass: z.number().int(),
        n_fail: z.number().int(),
        n_flaky: z.number().int(),
        n_error: z.number().int(),
      })
      .strict(),
    holdout: z
      .object({
        n_evals: z.number().int(),
        n_pass: z.number().int(),
        n_fail: z.number().int(),
        n_error: z.number().int(),
      })
      .strict(),
    failures: z.array(
      z
        .object({
          eval_id: z.string(),
          title: z.string(),
          input: z.string(),
          archetype_id: z.string().nullable(),
          scorer_primitive: z.string().nullable(),
          flaky: z.boolean(),
          reps: z.array(trainingFailureRepSchema),
        })
        .strict(),
    ),
    next_cursor: z.string().nullable(),
    truncated: z.boolean(),
    next_action: nextActionSchema,
  })
  .strict();

const pairSchema = z
  .object({ baseline: z.number(), candidate: z.number() })
  .strict();

const splitComparisonSchema = z
  .object({
    n_evals: z.number().int(),
    baseline_pass_rate: z.number(),
    candidate_pass_rate: z.number(),
    delta: z.number(),
    ci95: z.tuple([z.number(), z.number()]),
    noise_floor: z.number(),
    n_regressed: z.number().int(),
    n_flaky: pairSchema,
    n_error: pairSchema,
  })
  .strict();

const pairDeltaSchema = z
  .object({ baseline: z.number(), candidate: z.number(), delta: z.number() })
  .strict();

export const getVerdictOutputSchema = z
  .object({
    verdict: z.enum([
      "keep",
      "revert_overfit",
      "revert_regressed",
      "within_noise",
      "not_comparable",
    ]),
    reason: z.string(),
    objective: z.enum(["quality", "cost"]),
    directional: z.boolean(),
    underpowered: z.boolean(),
    advice: z.string().nullable(),
    eval_set_id: z.string(),
    n_shared_evals: z.number().int(),
    train: splitComparisonSchema,
    holdout: splitComparisonSchema,
    cost_per_call_usd: pairDeltaSchema,
    p50_latency_ms: pairDeltaSchema,
    session_id: z.string().nullable(),
    rounds: z.number().int().nullable(),
    flat_rounds: z.number().int().nullable(),
    plateau: z.boolean(),
    next_action: nextActionSchema,
  })
  .strict();

export const getEvalInputsOutputSchema = z
  .object({
    eval_set_id: z.string(),
    eval_set_version: z.number().int(),
    system_prompt: z.string().nullable(),
    n_evals: z.number().int(),
    inputs: z.array(z.object({ eval_id: z.string(), input: z.string() }).strict()),
    next_cursor: z.string().nullable(),
    truncated: z.boolean(),
    next_action: nextActionSchema,
  })
  .strict();

export const submitOutputsOutputSchema = z
  .object({
    run_id: z.string(),
    candidate_id: z.string(),
    eval_set_id: z.string(),
    n_scored: z.number().int(),
    n_error: z.number().int(),
    n_not_scored: z.number().int(),
    n_person_evals_not_graded: z.number().int(),
    grader_advice: z.string().nullable(),
    next_action: nextActionSchema,
  })
  .strict();

const judgeStatusSchema = z.enum(["uncalibrated", "stale", "trusted"]);

export const configureJudgeOutputSchema = z
  .object({
    judge_id: z.string(),
    eval_set_id: z.string(),
    judge_model: z.string(),
    config_hash: z.string(),
    rubric_source: z.enum(["input", "job"]),
    status: judgeStatusSchema,
    reason: z.string(),
    n_human_marked: z.number().int(),
    next_action: nextActionSchema,
  })
  .strict();

export const calibrateJudgeOutputSchema = z
  .object({
    judge_id: z.string(),
    calibration_id: z.string(),
    eval_set_id: z.string(),
    config_hash: z.string(),
    status: z.enum(["uncalibrated", "trusted"]),
    reason: z.string(),
    n_human_marked: z.number().int(),
    n_train: z.number().int(),
    n_test: z.number().int(),
    n_agree: z.number().int(),
    n_judge_errors: z.number().int(),
    accuracy: z.number().nullable(),
    kappa: z.number().nullable(),
    cost_usd: z.number(),
    thresholds: z
      .object({
        min_n_test: z.number().int(),
        min_accuracy: z.number(),
        min_kappa: z.number(),
      })
      .strict(),
    mark_url: z.string().nullable(),
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
  get_training_failures: getTrainingFailuresInputSchema,
  get_verdict: getVerdictInputSchema,
  get_eval_inputs: getEvalInputsInputSchema,
  submit_outputs: submitOutputsInputSchema,
  configure_judge: configureJudgeInputSchema,
  calibrate_judge: calibrateJudgeInputSchema,
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
  if (needsIdempotencyKey(name, body)) {
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
