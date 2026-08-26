import type { AgentError, ErrorCodeName, NextAction, ToolName } from "./tools/types.js";
import { ErrorCode } from "./tools/types.js";

/**
 * Slice 0 uses this HTTP 401 body for missing or bad Bearer keys.
 */
export const unauthorizedBody = { error: "unauthorized" } as const;

export type { AgentError, NextAction };

export function agentError(init: {
  code: ErrorCodeName;
  message: string;
  retryable: boolean;
  suggested_tool: ToolName | null;
  suggested_args?: Record<string, unknown>;
  next_action: NextAction;
  run_id?: string | null;
  failing_eval_ids?: string[];
  mark_url?: string | null;
}): AgentError {
  const envelope: AgentError = {
    code: init.code,
    message: init.message,
    retryable: init.retryable,
    suggested_tool: init.suggested_tool,
    suggested_args: init.suggested_args ?? {},
    next_action: init.next_action,
  };
  if (init.run_id !== undefined) {
    envelope.run_id = init.run_id;
  }
  if (init.failing_eval_ids !== undefined) {
    envelope.failing_eval_ids = init.failing_eval_ids;
  }
  if (init.mark_url !== undefined) {
    envelope.mark_url = init.mark_url;
  }
  return envelope;
}

export function projectNotFoundError(projectId: string): AgentError {
  return agentError({
    code: ErrorCode.PROJECT_NOT_FOUND,
    message: "Project not found",
    retryable: false,
    suggested_tool: null,
    suggested_args: { project_id: projectId },
    next_action: {
      tool: null,
      args: { project_id: projectId },
      ask_human: "Pass a real prj_",
    },
  });
}

export function noLastKnownPolicyError(projectId: string): AgentError {
  return agentError({
    code: ErrorCode.NO_LAST_KNOWN_POLICY,
    message: "This project has no last-known policy.",
    retryable: false,
    suggested_tool: "compile_policy",
    suggested_args: { project_id: projectId },
    next_action: {
      tool: "compile_policy",
      args: { project_id: projectId },
      ask_human: null,
    },
  });
}

export function recNotApprovedError(recommendationId: string): AgentError {
  return agentError({
    code: ErrorCode.REC_NOT_APPROVED,
    message: "No person approved this recommendation.",
    retryable: false,
    suggested_tool: null,
    suggested_args: { recommendation_id: recommendationId },
    next_action: {
      tool: null,
      args: { recommendation_id: recommendationId },
      ask_human: "open approve_url",
    },
  });
}

export function policyNotApprovedError(args: {
  project_id: string;
  approve_url?: string;
}): AgentError {
  const hasUrl = typeof args.approve_url === "string" && args.approve_url.length > 0;
  return agentError({
    code: ErrorCode.POLICY_NOT_APPROVED,
    message: "A draft policy exists. It is not live.",
    retryable: true,
    suggested_tool: hasUrl ? null : "compile_policy",
    suggested_args: hasUrl
      ? { approve_url: args.approve_url }
      : { project_id: args.project_id },
    next_action: {
      tool: hasUrl ? null : "compile_policy",
      args: hasUrl
        ? { approve_url: args.approve_url }
        : { project_id: args.project_id },
      ask_human: hasUrl ? "open approve_url" : null,
    },
  });
}

export function canaryNotActiveError(projectId: string): AgentError {
  return agentError({
    code: ErrorCode.CANARY_NOT_ACTIVE,
    message: "There is no active canary.",
    retryable: true,
    suggested_tool: "propose_rollout",
    suggested_args: { project_id: projectId, intent: "canary" },
    next_action: {
      tool: "propose_rollout",
      args: { project_id: projectId, intent: "canary" },
      ask_human: null,
    },
  });
}

export function notASampleError(args: {
  project_id: string;
}): AgentError {
  const nextArgs = { project_id: args.project_id };
  return agentError({
    code: ErrorCode.NOT_A_SAMPLE,
    message: "The id is not a sample.",
    retryable: false,
    suggested_tool: "get_live_report",
    suggested_args: nextArgs,
    next_action: {
      tool: "get_live_report",
      args: nextArgs,
      ask_human: null,
    },
  });
}

export function piiBlockedError(): AgentError {
  return agentError({
    code: ErrorCode.PII_BLOCKED,
    message: "Capture did not store the example.",
    retryable: false,
    suggested_tool: null,
    suggested_args: {},
    next_action: {
      tool: null,
      args: {},
      ask_human: null,
    },
  });
}

export function steMismatchError(args: {
  project_id: string;
  recommendation_id: string;
  eval_set_id: string;
}): AgentError {
  return agentError({
    code: ErrorCode.STE_MISMATCH,
    message: "The eval set is not the eval set on this recommendation.",
    retryable: true,
    suggested_tool: "compile_policy",
    suggested_args: {
      project_id: args.project_id,
      recommendation_id: args.recommendation_id,
      eval_set_id: args.eval_set_id,
    },
    next_action: {
      tool: "compile_policy",
      args: {
        project_id: args.project_id,
        recommendation_id: args.recommendation_id,
      },
      ask_human: null,
    },
  });
}

export function suiteNotFoundError(evalSetId: string): AgentError {
  return agentError({
    code: ErrorCode.SUITE_NOT_FOUND,
    message: "Eval set not found",
    retryable: false,
    suggested_tool: null,
    suggested_args: { eval_set_id: evalSetId },
    next_action: {
      tool: null,
      args: { eval_set_id: evalSetId },
      ask_human: "Pass a saved ste_",
    },
  });
}

export function needMoreEvalsError(
  projectId: string,
  evalSetId: string,
  markUrl?: string | null,
): AgentError {
  const hasMarkLink = typeof markUrl === "string" && markUrl.length > 0;
  return agentError({
    code: ErrorCode.need_more_evals,
    message: "Too few trusted evals to run",
    retryable: true,
    suggested_tool: "queue_for_labeling",
    suggested_args: { project_id: projectId, eval_set_id: evalSetId },
    mark_url: markUrl ?? null,
    next_action: {
      tool: hasMarkLink ? "get_label_status" : "queue_for_labeling",
      args: { project_id: projectId, eval_set_id: evalSetId },
      ask_human: hasMarkLink ? "open mark_url" : null,
    },
  });
}

export function costCapRequiredError(args: {
  project_id: string;
  eval_set_id: string;
}): AgentError {
  const retryArgs = {
    project_id: args.project_id,
    eval_set_id: args.eval_set_id,
    max_eval_spend_usd: 1,
  };
  return agentError({
    code: ErrorCode.COST_CAP_REQUIRED,
    message: "max_eval_spend_usd must be greater than 0 for recheck",
    retryable: true,
    suggested_tool: "run_evals",
    suggested_args: retryArgs,
    next_action: { tool: "run_evals", args: retryArgs, ask_human: null },
  });
}

export function namedModelMismatchError(): AgentError {
  return agentError({
    code: ErrorCode.NAMED_MODEL_MISMATCH,
    message: "named_model does not match saved recommendation",
    retryable: false,
    suggested_tool: null,
    suggested_args: {},
    next_action: {
      tool: null,
      args: {},
      ask_human: "Pass the saved named model",
    },
  });
}

export function costCapExceededError(runId: string): AgentError {
  return agentError({
    code: ErrorCode.COST_CAP_EXCEEDED,
    message: "Eval spend hit the cost cap",
    retryable: true,
    suggested_tool: "get_eval_report",
    suggested_args: { run_id: runId },
    run_id: runId,
    next_action: {
      tool: "get_eval_report",
      args: { run_id: runId },
      ask_human: null,
    },
  });
}

export function invalidInputError(
  message: string,
  tool: ToolName = "generate_eval_suite",
): AgentError {
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message,
    retryable: true,
    suggested_tool: tool,
    suggested_args: {},
    next_action: { tool, args: {}, ask_human: null },
  });
}

export function jobUnclearError(): AgentError {
  return agentError({
    code: ErrorCode.JOB_UNCLEAR,
    message: "Cannot write evals from the description. Ask what good means.",
    retryable: true,
    suggested_tool: "generate_eval_suite",
    suggested_args: {},
    next_action: {
      tool: null,
      args: {},
      ask_human: "what good means",
    },
  });
}
