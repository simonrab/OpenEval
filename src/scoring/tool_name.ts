import { parseToolCalls } from "./tool-call.js";

export function scoreToolName(
  output: string,
  expected: unknown,
): { passed: boolean; reason_short: string } {
  const want = String(expected);
  const trimmed = output.trim();
  const calls = parseToolCalls(trimmed);
  const found =
    trimmed === want ||
    (calls === null ? trimmed.includes(want) : calls.some((c) => c.name === want));
  return found
    ? { passed: true, reason_short: `tool ${want}` }
    : { passed: false, reason_short: `tool not ${want}` };
}
