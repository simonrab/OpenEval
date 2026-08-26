export const DEFAULT_MODELS = [
  "openai/gpt-4o-mini",
  "google/gemini-flash-1.5",
  "anthropic/claude-3-haiku",
  "meta-llama/llama-3.1-8b-instruct",
  "mistralai/mistral-7b-instruct",
] as const;

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
  }): Promise<ChatCompletionResult>;
};

export function createOpenRouterClient(
  fetchFn: typeof fetch = fetch,
): OpenRouterClient {
  return {
    async chatCompletion({ model, prompt, apiKey }) {
      const started = Date.now();
      const res = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://evalrouter.local",
          "X-Title": "EvalRouter",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
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
  };
}

export function createMockOpenRouter(
  responses: Record<string, string> | ((model: string, prompt: string) => ChatCompletionResult),
  defaultCost = 0.05,
): OpenRouterClient {
  return {
    async chatCompletion({ model, prompt, apiKey }) {
      void apiKey;
      if (typeof responses === "function") {
        return responses(model, prompt);
      }
      const key = `${model}:${prompt.slice(0, 80)}`;
      const content = responses[key] ?? responses[model] ?? responses["*"] ?? '{"ok":true}';
      return { content, time_ms: 10, cost_usd: defaultCost };
    },
  };
}
