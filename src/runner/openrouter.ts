import {
  parseOpenRouterModels,
  type CatalogModel,
} from "./catalog.js";
import {
  parseToolArguments,
  toolCallOutput,
  type NativeToolCall,
} from "../scoring/tool-call.js";

/** Model call settings that a candidate can change. */
export type ModelSettings = {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning_effort?: "minimal" | "low" | "medium" | "high";
};

/** provider = cost reported by OpenRouter. estimate = token count times a flat rate. */
export type CostSource = "provider" | "estimate";

/** A tool the job gives the model. parameters is a JSON schema. */
export type ToolDefinition = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type ToolChoice = "auto" | "required" | "none" | { name: string };

export type ChatCompletionResult = {
  content: string;
  time_ms: number;
  cost_usd: number;
  cost_source?: CostSource;
  prompt_tokens?: number;
  completion_tokens?: number;
  served_model?: string;
  /** Native tool calls in the reply. arguments is parsed JSON when it parses. */
  tool_calls?: NativeToolCall[];
};

export type ChatCompletionInput = {
  model: string;
  prompt: string;
  apiKey: string;
  systemPrompt?: string;
  settings?: ModelSettings;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
};

export type OpenRouterClient = {
  chatCompletion(input: ChatCompletionInput): Promise<ChatCompletionResult>;
  listModels?(apiKey: string): Promise<CatalogModel[]>;
};

/** The output that scorers see: the text, or the tool calls as JSON when the model called a tool. */
export function scoredOutput(result: ChatCompletionResult): string {
  return result.tool_calls && result.tool_calls.length > 0
    ? toolCallOutput(result.content, result.tool_calls)
    : result.content;
}

export function toolsBody(
  tools: ToolDefinition[] | undefined,
  toolChoice: ToolChoice | undefined,
): Record<string, unknown> {
  if (!tools || tools.length === 0) {
    return {};
  }
  const body: Record<string, unknown> = {
    tools: tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.parameters ?? { type: "object", properties: {} },
      },
    })),
  };
  if (toolChoice) {
    body.tool_choice =
      typeof toolChoice === "string"
        ? toolChoice
        : { type: "function", function: { name: toolChoice.name } };
  }
  return body;
}

function readToolCalls(raw: unknown): NativeToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const calls: NativeToolCall[] = [];
  for (const item of raw) {
    const fn = (item as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
    if (fn && typeof fn.name === "string" && fn.name.length > 0) {
      calls.push({ name: fn.name, arguments: parseToolArguments(fn.arguments) });
    }
  }
  return calls;
}

const REQUEST_TIMEOUT_MS = 120_000;
const ESTIMATE_USD_PER_TOKEN = 0.000002;

export function settingsBody(settings: ModelSettings | undefined): Record<string, unknown> {
  if (!settings) {
    return {};
  }
  const body: Record<string, unknown> = {};
  if (settings.temperature != null) body.temperature = settings.temperature;
  if (settings.top_p != null) body.top_p = settings.top_p;
  if (settings.max_tokens != null) body.max_tokens = settings.max_tokens;
  if (settings.reasoning_effort != null) {
    body.reasoning = { effort: settings.reasoning_effort };
  }
  return body;
}

const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://openeval.local",
  "X-Title": "OpenEval",
} as const;

async function listOpenRouterModels(
  fetchFn: typeof fetch,
  apiKey: string,
): Promise<CatalogModel[]> {
  const collected: CatalogModel[] = [];
  let url: string | null = "https://openrouter.ai/api/v1/models";
  for (let page = 0; page < 5 && url; page += 1) {
    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...OPENROUTER_HEADERS,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter models ${res.status}: ${text.slice(0, 200)}`);
    }
    const payload = (await res.json()) as {
      data?: unknown;
      links?: { next?: string | null };
    };
    collected.push(...parseOpenRouterModels(payload));
    const next = payload.links?.next;
    url =
      typeof next === "string" && next.length > 0
        ? next.startsWith("http")
          ? next
          : `https://openrouter.ai${next}`
        : null;
  }
  return collected;
}

export function createOpenRouterClient(
  fetchFn: typeof fetch = fetch,
): OpenRouterClient {
  return {
    async chatCompletion({ model, prompt, apiKey, systemPrompt, settings, tools, toolChoice }) {
      const started = Date.now();
      const messages = [
        ...(systemPrompt && systemPrompt.length > 0
          ? [{ role: "system" as const, content: systemPrompt }]
          : []),
        { role: "user" as const, content: prompt },
      ];
      const res = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...OPENROUTER_HEADERS,
        },
        body: JSON.stringify({
          model,
          messages,
          ...settingsBody(settings),
          ...toolsBody(tools, toolChoice),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown } }>;
        usage?: {
          cost?: number;
          total_cost?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
        };
      };
      const message = data.choices?.[0]?.message;
      const content = message?.content ?? "";
      const toolCalls = readToolCalls(message?.tool_calls);
      const elapsed = Date.now() - started;
      const promptTokens = data.usage?.prompt_tokens ?? 0;
      const completionTokens = data.usage?.completion_tokens ?? 0;
      // OpenRouter reports the real charge as usage.cost.
      const reported = data.usage?.cost ?? data.usage?.total_cost;
      const hasReported = typeof reported === "number" && Number.isFinite(reported);
      return {
        content,
        time_ms: elapsed,
        cost_usd: hasReported
          ? reported
          : (promptTokens + completionTokens) * ESTIMATE_USD_PER_TOKEN,
        cost_source: hasReported ? "provider" : "estimate",
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        served_model: typeof data.model === "string" ? data.model : undefined,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    },
    listModels(apiKey) {
      return listOpenRouterModels(fetchFn, apiKey);
    },
  };
}

export const MOCK_CATALOG: CatalogModel[] = [
  {
    id: "openai/gpt-4.1-nano",
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.0001,
    created: 1_740_000_000,
  },
  {
    id: "google/gemini-2.5-flash",
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.00015,
    created: 1_741_000_000,
  },
  {
    id: "anthropic/claude-haiku-4.5",
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.0004,
    created: 1_742_000_000,
  },
  {
    id: "mistralai/mistral-small-3.1",
    supportsImages: false,
    inputModalities: ["text"],
    listCostPer1kUsd: 0.00008,
    created: 1_740_500_000,
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    supportsImages: false,
    inputModalities: ["text"],
    listCostPer1kUsd: 0.00012,
    created: 1_730_000_000,
  },
  {
    id: "openai/gpt-4o-mini",
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.0002,
    created: 1_720_000_000,
  },
  {
    id: "google/gemini-flash-1.5",
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.000075,
    created: 1_700_000_000,
  },
  {
    id: "openai/gpt-4o",
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.005,
    created: 1_718_000_000,
  },
  {
    id: "google/gemini-2.5-flash:free",
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0,
    created: 1_741_000_000,
  },
];

export function createMockOpenRouter(
  responses: Record<string, string> | ((model: string, prompt: string) => ChatCompletionResult),
  defaultCost = 0.05,
  catalog: CatalogModel[] = MOCK_CATALOG,
): OpenRouterClient {
  return {
    async chatCompletion({ model, prompt, apiKey, systemPrompt, settings }) {
      void apiKey;
      void systemPrompt;
      if (typeof responses === "function") {
        return responses(model, prompt);
      }
      const key = `${model}:${prompt.slice(0, 80)}`;
      const content = responses[key] ?? responses[model] ?? responses["*"] ?? '{"ok":true}';
      return { content, time_ms: 10, cost_usd: defaultCost };
    },
    async listModels(apiKey) {
      void apiKey;
      return catalog;
    },
  };
}
