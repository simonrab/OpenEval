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

export function createMcpServer(config: McpClientConfig): McpServer {
  const server = new McpServer(
    { name: "evalrouter", version: "0.0.0" },
    {
      instructions:
        "EvalRouter agent tools. Same JSON as POST /v1/tools/{name}. Requires evalrouter serve running.",
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
          content: [{ type: "text", text: JSON.stringify(result.body) }],
          isError: result.status >= 400,
        };
      },
    );
  }

  return server;
}
