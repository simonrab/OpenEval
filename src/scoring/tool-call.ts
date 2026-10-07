/** One tool call read from a model output. */
export type ToolCall = { name: string | undefined; args: unknown };

/** A native tool call that a model sent back, before it becomes the scored output. */
export type NativeToolCall = { name: string; arguments: unknown };

function parseLoose(text: string): unknown | null {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(trimmed);
  try {
    return JSON.parse(fence ? fence[1]!.trim() : trimmed) as unknown;
  } catch {
    return null;
  }
}

/** Parse tool arguments. A model sends them as a JSON string. Bad JSON stays as the raw string. */
export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw ?? {};
  }
  if (raw.trim() === "") {
    return {};
  }
  const parsed = parseLoose(raw);
  return parsed === null ? raw : parsed;
}

/**
 * The scored output for a model reply that has native tool calls.
 * Scorers read this shape: {"content": text or null, "tool_calls": [{"name", "arguments"}]}.
 */
export function toolCallOutput(content: string, calls: NativeToolCall[]): string {
  return JSON.stringify({
    content: content.length > 0 ? content : null,
    tool_calls: calls.map((c) => ({ name: c.name, arguments: c.arguments })),
  });
}

function readCall(raw: unknown): ToolCall | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const call = raw as Record<string, unknown>;
  // OpenAI shape: {"type":"function","function":{"name","arguments"}}.
  if (call.function && typeof call.function === "object" && !Array.isArray(call.function)) {
    const fn = call.function as Record<string, unknown>;
    return {
      name: typeof fn.name === "string" ? fn.name : undefined,
      args: parseToolArguments(fn.arguments ?? fn.args ?? fn.parameters),
    };
  }
  const name = call.name ?? call.tool_name ?? call.tool ?? call.function;
  return {
    name: typeof name === "string" ? name : undefined,
    args: parseToolArguments(call.arguments ?? call.args ?? call.parameters ?? call.input),
  };
}

/**
 * Read the tool calls in a model output.
 * Accepts {"tool_calls": [...]}, a bare array of calls, or one flat call {"name", "arguments"}.
 * Returns null when the output is not JSON. Returns [] when the output is JSON with no tool call.
 */
export function parseToolCalls(output: string): ToolCall[] | null {
  const parsed = parseLoose(output);
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { tool_calls?: unknown }).tool_calls)
      ? ((parsed as { tool_calls: unknown[] }).tool_calls)
      : "tool_calls" in (parsed as object)
        ? []
        : [parsed];
  return list
    .map(readCall)
    .filter((c): c is ToolCall => c !== null && c.name !== undefined);
}
