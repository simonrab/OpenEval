import { zodToJsonSchema } from "zod-to-json-schema";
import {
  toolInputSchemas,
  TOOL_NAMES,
  type ToolName,
} from "../tools/schema.js";

export type McpToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  zodInputSchema: (typeof toolInputSchemas)[ToolName];
};

const MCP_DESCRIPTIONS: Record<ToolName, string> = {
  generate_eval_suite:
    "Start here. Write draft evals for one job the user names. If the user gives labeled examples, pass them in labeled_examples. Do not invent examples. Then follow next_action.",
  queue_for_labeling:
    "Queue evals that a person must mark. Show mark_url and stop.",
  get_label_status: "Return mark counts for an eval set.",
  run_evals: "Run models on a frozen eval set.",
  recommend_models:
    "Name the cheapest fast model that still passes. Show approve_url and stop.",
  register_failure: "Add a failure as a new eval on a new eval-set version.",
  get_eval_report: "Return a short eval run report that fits in context.",
  compile_policy: "Compile rec_ and ste_ into a pol_. This tool does not send live traffic.",
  get_live_report: "Return live counts, last-known age, and paginated sample ids.",
  promote_live_sample: "Turn a live sample into a v0 failure.",
  propose_rollout: "Propose canary, full, or rollback. This tool does not apply.",
  configure_live_automation: "Configure guarded live automation rules for one project.",
  run_live_decision_cycle: "Run one guarded live decision cycle for one project.",
  get_decision_cycle_status: "Return the last guarded decision cycle status.",
};

function toJsonSchema(name: ToolName): Record<string, unknown> {
  return zodToJsonSchema(toolInputSchemas[name], {
    $refStrategy: "none",
    strictUnions: true,
  }) as Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  description: MCP_DESCRIPTIONS[name],
  inputSchema: toJsonSchema(name),
  zodInputSchema: toolInputSchemas[name],
}));

export function getMcpInputSchema(name: ToolName): Record<string, unknown> {
  return toJsonSchema(name);
}
