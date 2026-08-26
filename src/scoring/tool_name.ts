export function scoreToolName(
  output: string,
  expected: unknown,
): { passed: boolean; reason_short: string } {
  const want = String(expected);
  const trimmed = output.trim();
  let found = trimmed === want;
  if (!found) {
    try {
      const parsed = JSON.parse(trimmed) as { name?: string; tool?: string };
      found = parsed.name === want || parsed.tool === want;
    } catch {
      found = trimmed.includes(want);
    }
  }
  return found
    ? { passed: true, reason_short: `tool ${want}` }
    : { passed: false, reason_short: `tool not ${want}` };
}
