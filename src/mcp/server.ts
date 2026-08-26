import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_TOOLS } from "./tools.js";

export type McpClientConfig = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
};

export type ToolCallResult = {
  status: number;
  body: unknown;
};

export async function callToolViaHttp(
  name: string,
  body: unknown,
  config: McpClientConfig,
): Promise<ToolCallResult> {
  const base = config.baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/tools/${encodeURIComponent(name)}`;
  const res = await (config.fetch ?? fetch)(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

export const MCP_INSTRUCTIONS = [
  "The user names one job. That is the whole request.",
  "Call generate_eval_suite first. Then call only next_action.tool.",
  "When the result starts with Stop, show the URL to the user and wait.",
  "Do not accept, mark, or approve. Do not write a model id until the user approves.",
  "If a project or keys_ref is missing, create it. Do not ask the user to curl.",
].join(" ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function urlForAskHuman(
  body: Record<string, unknown>,
  askHuman: string,
): string | null {
  const key = askHuman.startsWith("open ") ? askHuman.slice("open ".length) : null;
  if (!key) {
    return null;
  }
  const top = body[key];
  if (typeof top === "string" && top.length > 0) {
    return top;
  }
  const nextAction = isRecord(body.next_action) ? body.next_action : null;
  const args = nextAction && isRecord(nextAction.args) ? nextAction.args : null;
  const nested = args ? args[key] : null;
  return typeof nested === "string" && nested.length > 0 ? nested : null;
}

export function formatMcpToolContent(body: unknown): string {
  const json = JSON.stringify(body, null, 2);
  if (!isRecord(body) || !isRecord(body.next_action)) {
    return json;
  }
  const askHuman = body.next_action.ask_human;
  if (typeof askHuman === "string" && askHuman.length > 0) {
    const url = urlForAskHuman(body, askHuman);
    if (url) {
      return `Stop. Show this URL to the user and wait: ${url}\n\n${json}`;
    }
    return `Stop. Ask the user: ${askHuman}\n\n${json}`;
  }
  const tool = body.next_action.tool;
  if (typeof tool === "string" && tool.length > 0) {
    return `Next: call ${tool}.\n\n${json}`;
  }
  return json;
}

export function createMcpServer(config: McpClientConfig): McpServer {
  const server = new McpServer(
    { name: "evalrouter", version: "0.0.0" },
    {
      instructions: MCP_INSTRUCTIONS,
    },
  );

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.zodInputSchema,
      },
      async (args) => {
        const result = await callToolViaHttp(tool.name, args, config);
        return {
          content: [{ type: "text", text: formatMcpToolContent(result.body) }],
          isError: result.status >= 400,
        };
      },
    );
  }

  return server;
}
