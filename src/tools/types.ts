import { z } from "zod";

export const TOOL_NAMES = [
  "generate_eval_suite",
  "queue_for_labeling",
  "get_label_status",
  "run_evals",
  "recommend_models",
  "register_failure",
  "get_eval_report",
  "compile_policy",
  "get_live_report",
  "promote_live_sample",
  "propose_rollout",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

export const ASK_HUMAN = [
  "what good means",
  "open accept_url",
  "open mark_url",
  "open approve_url",
  "open sample_url",
  "none of the models passed; see failing_eval_ids",
  "Pass a real prj_",
  "Pass a saved ste_",
  "Pass the saved named model",
  "named model rejected; do not write it into config",
] as const;

export type AskHuman = (typeof ASK_HUMAN)[number];

export const ErrorCode = {
  need_more_evals: "need_more_evals",
  does_not_work: "does_not_work",
  need_new_model: "need_new_model",
  evals_missing_new_failures: "evals_missing_new_failures",
  COST_CAP_EXCEEDED: "COST_CAP_EXCEEDED",
  JOB_UNCLEAR: "JOB_UNCLEAR",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  SUITE_NOT_FOUND: "SUITE_NOT_FOUND",
  NAMED_MODEL_MISMATCH: "NAMED_MODEL_MISMATCH",
  COST_CAP_REQUIRED: "COST_CAP_REQUIRED",
  NOT_BUILT: "NOT_BUILT",
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  INVALID_INPUT: "INVALID_INPUT",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
  NO_LAST_KNOWN_POLICY: "NO_LAST_KNOWN_POLICY",
  REC_NOT_APPROVED: "REC_NOT_APPROVED",
  STE_MISMATCH: "STE_MISMATCH",
  PII_BLOCKED: "PII_BLOCKED",
  CONTROL_PLANE_UNREACHABLE: "CONTROL_PLANE_UNREACHABLE",
  NOT_A_SAMPLE: "NOT_A_SAMPLE",
  POLICY_NOT_APPROVED: "POLICY_NOT_APPROVED",
  CANARY_NOT_ACTIVE: "CANARY_NOT_ACTIVE",
} as const;

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_CODES: readonly ErrorCodeName[] = Object.values(ErrorCode);

export const toolNameSchema = z.enum(TOOL_NAMES);

export const askHumanSchema = z.enum(ASK_HUMAN);

export const nextActionSchema = z.object({
  tool: toolNameSchema.nullable(),
  args: z.record(z.unknown()),
  ask_human: askHumanSchema.nullable(),
});

export type NextAction = z.infer<typeof nextActionSchema>;

export const errorCodeSchema = z.enum(
  Object.values(ErrorCode) as [ErrorCodeName, ...ErrorCodeName[]],
);

export const agentErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  suggested_tool: toolNameSchema.nullable(),
  suggested_args: z.record(z.unknown()),
  run_id: z.string().nullable().optional(),
  failing_eval_ids: z.array(z.string()).optional(),
  mark_url: z.string().nullable().optional(),
  next_action: nextActionSchema,
});

export type AgentError = z.infer<typeof agentErrorSchema>;

export function isAgentError(value: unknown): value is AgentError {
  return agentErrorSchema.safeParse(value).success;
}
