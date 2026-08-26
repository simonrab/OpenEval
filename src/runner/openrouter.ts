import {
  parseOpenRouterModels,
  type CatalogModel,
} from "./catalog.js";

export type ChatCompletionResult = {
  content: string;
  time_ms: number;
  cost_usd: number;
};

export type OpenRouterClient = {
  chatCompletion(input: {
    model: string;
    prompt: string;
    apiKey: string;
    systemPrompt?: string;
  }): Promise<ChatCompletionResult>;
  listModels?(apiKey: string): Promise<CatalogModel[]>;
};

const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://evalrouter.local",
  "X-Title": "EvalRouter",
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
    async chatCompletion({ model, prompt, apiKey, systemPrompt }) {
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
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_cost?: number; prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const elapsed = Date.now() - started;
      let cost = data.usage?.total_cost ?? 0;
      if (cost === 0) {
        const tokens =
          (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);
        cost = tokens * 0.000002;
      }
      return { content, time_ms: elapsed, cost_usd: cost };
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
    async chatCompletion({ model, prompt, apiKey, systemPrompt }) {
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
