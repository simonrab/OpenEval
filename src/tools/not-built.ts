import { agentError } from "../errors.js";
import type { ToolName } from "./schema.js";
import { ErrorCode, type AgentError } from "./types.js";

export function notBuiltError(tool: ToolName): AgentError {
  return agentError({
    code: ErrorCode.NOT_BUILT,
    message: `${tool} is not built yet`,
    retryable: false,
    suggested_tool: tool,
    suggested_args: {},
    next_action: {
      tool,
      args: {},
      ask_human: null,
    },
  });
}
