import { agentError } from "./errors.js";
import { handleGenerateEvalSuite } from "./tools/generate_eval_suite.js";
import { handleGetEvalReport } from "./tools/get_eval_report.js";
import { handleGetLabelStatus } from "./tools/get_label_status.js";
import { handleQueueForLabeling } from "./tools/queue_for_labeling.js";
import { handleRecommendModels } from "./tools/recommend_models.js";
import { handleRegisterFailure } from "./tools/register_failure.js";
import { handleRunEvals } from "./tools/run_evals.js";
import { notBuiltError } from "./tools/not-built.js";
import { isToolName, parseToolInput, TOOL_NAMES } from "./tools/schema.js";
import { ErrorCode } from "./tools/types.js";
import type Database from "better-sqlite3";

export type ToolContext = {
  projectId?: string;
  db?: Database.Database;
  apiKey?: string;
  baseUrl?: string;
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

  const parsed = parseToolInput(name, body);
  if (!parsed.ok) {
    return { status: 400, body: parsed.error };
  }

  const handler = handlers.get(name);
  if (!handler) {
    return { status: 501, body: notBuiltError(name) };
  }
  return handler(parsed.data, ctx);
}
