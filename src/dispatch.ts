import type { AuthScope } from "./auth.js";
import { agentError } from "./errors.js";
import { handleCompilePolicy } from "./tools/compile_policy.js";
import { handleGetLiveReport } from "./tools/get_live_report.js";
import { handlePromoteLiveSample } from "./tools/promote_live_sample.js";
import { handleProposeRollout } from "./tools/propose_rollout.js";
import {
  handleConfigureLiveAutomation,
  handleGetDecisionCycleStatus,
  handleRunLiveDecisionCycle,
} from "./tools/live_automation.js";
import { handleGenerateEvalSuite } from "./tools/generate_eval_suite.js";
import { handleGetEvalReport } from "./tools/get_eval_report.js";
import { handleGetLabelStatus } from "./tools/get_label_status.js";
import { handleGetTrainingFailures } from "./tools/get_training_failures.js";
import { handleGetVerdict } from "./tools/get_verdict.js";
import { handleGetEvalInputs } from "./tools/get_eval_inputs.js";
import { handleSubmitOutputs } from "./tools/submit_outputs.js";
import { handleConfigureJudge } from "./tools/configure_judge.js";
import { handleCalibrateJudge } from "./tools/calibrate_judge.js";
import { checkScope, redactForScope } from "./tools/scope.js";
import { handleQueueForLabeling } from "./tools/queue_for_labeling.js";
import { handleRecommendModels } from "./tools/recommend_models.js";
import { handleRegisterFailure } from "./tools/register_failure.js";
import { handleRunEvals } from "./tools/run_evals.js";
import { notBuiltError } from "./tools/not-built.js";
import { isToolName, parseToolInput, TOOL_NAMES } from "./tools/schema.js";
import { ErrorCode } from "./tools/types.js";
import type { OpenRouterClient } from "./runner/openrouter.js";
import type Database from "better-sqlite3";

export type ToolContext = {
  projectId?: string;
  db?: Database.Database;
  apiKey?: string;
  baseUrl?: string;
  openRouter?: OpenRouterClient;
  /** Missing means full scope (in-process callers and the server key). */
  scope?: AuthScope;
};

export type DispatchResult = {
  status: number;
  body: unknown;
};

export type ToolHandler = (
  body: unknown,
  ctx: ToolContext,
) => Promise<DispatchResult> | DispatchResult;

export const handlers: Map<string, ToolHandler> = new Map();

for (const name of TOOL_NAMES) {
  handlers.set(name, () => ({
    status: 501,
    body: notBuiltError(name),
  }));
}

handlers.set("generate_eval_suite", handleGenerateEvalSuite);
handlers.set("queue_for_labeling", handleQueueForLabeling);
handlers.set("get_label_status", handleGetLabelStatus);
handlers.set("run_evals", handleRunEvals);
handlers.set("get_eval_report", handleGetEvalReport);
handlers.set("recommend_models", handleRecommendModels);
handlers.set("register_failure", handleRegisterFailure);
handlers.set("compile_policy", handleCompilePolicy);
handlers.set("get_live_report", handleGetLiveReport);
handlers.set("promote_live_sample", handlePromoteLiveSample);
handlers.set("propose_rollout", handleProposeRollout);
handlers.set("configure_live_automation", handleConfigureLiveAutomation);
handlers.set("run_live_decision_cycle", handleRunLiveDecisionCycle);
handlers.set("get_decision_cycle_status", handleGetDecisionCycleStatus);
handlers.set("get_training_failures", handleGetTrainingFailures);
handlers.set("get_verdict", handleGetVerdict);
handlers.set("get_eval_inputs", handleGetEvalInputs);
handlers.set("submit_outputs", handleSubmitOutputs);
handlers.set("configure_judge", handleConfigureJudge);
handlers.set("calibrate_judge", handleCalibrateJudge);

function unknownToolError() {
  return agentError({
    code: ErrorCode.UNKNOWN_TOOL,
    message: "Unknown tool",
    retryable: false,
    suggested_tool: null,
    suggested_args: {},
    next_action: { tool: null, args: {}, ask_human: null },
  });
}

export async function dispatch(
  name: string,
  body: unknown,
  ctx: ToolContext = {},
): Promise<DispatchResult> {
  if (!isToolName(name)) {
    return { status: 404, body: unknownToolError() };
  }

  const toolDenied = checkScope(ctx, name, null);
  if (toolDenied) {
    return toolDenied;
  }

  const parsed = parseToolInput(name, body);
  if (!parsed.ok) {
    return { status: 400, body: parsed.error };
  }

  const inputDenied = checkScope(ctx, name, parsed.data);
  if (inputDenied) {
    return inputDenied;
  }

  const handler = handlers.get(name);
  if (!handler) {
    return { status: 501, body: notBuiltError(name) };
  }
  return redactForScope(ctx, await handler(parsed.data, ctx));
}
