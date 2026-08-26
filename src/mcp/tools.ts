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

function toJsonSchema(name: ToolName): Record<string, unknown> {
  return zodToJsonSchema(toolInputSchemas[name], {
    $refStrategy: "none",
    strictUnions: true,
  }) as Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  description: `EvalRouter ${name}`,
  inputSchema: toJsonSchema(name),
  zodInputSchema: toolInputSchemas[name],
}));

export function getMcpInputSchema(name: ToolName): Record<string, unknown> {
  return toJsonSchema(name);
}
