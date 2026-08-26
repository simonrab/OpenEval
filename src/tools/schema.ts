import { z } from "zod";
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
    limits: limitsSchema.optional(),
    what_good_means: whatGoodMeansSchema.nullable().optional(),
    size: z.enum(["smoke", "standard"]).optional(),
    idempotency_key: z.string().min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    const hasDescription =
      typeof val.description === "string" && val.description.length > 0;
    const hasGood = val.what_good_means != null;
    if (!hasDescription && !hasGood) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "description or what_good_means is required",
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

const programCheckSchema = z
  .object({
    kind: z.enum([
      "json_valid",
      "tool_name",
      "field_equals",
      "must_not_contain",
      "fixture",
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
        files: z.array(z.object({ path: z.string() }).strict()).optional(),
      })
      .strict(),
    output: z.record(z.unknown()).optional(),
    why_bad: z.string().optional(),
    trace: z.string().optional(),
    program_check: programCheckSchema.optional(),
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
    counts: z
      .object({
        draft: z.number().int(),
        code: z.number().int(),
        needs_person: z.number().int(),
        trusted: z.number().int(),
        total: z.number().int(),
      })
      .strict(),
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
    items: z.array(
      z
        .object({
          eval_id: z.string(),
          title: z.string(),
          passed: z.boolean(),
          reason_short: z.string(),
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

export const toolInputSchemas: Record<ToolName, z.ZodType> = {
  generate_eval_suite: generateEvalSuiteInputSchema,
  queue_for_labeling: queueForLabelingInputSchema,
  get_label_status: getLabelStatusInputSchema,
  run_evals: runEvalsInputSchema,
  recommend_models: recommendModelsInputSchema,
  register_failure: registerFailureInputSchema,
  get_eval_report: getEvalReportInputSchema,
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
