function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(trimmed);
  if (fence) {
    return fence[1].trim();
  }
  return trimmed;
}

export function scoreJsonValid(
  output: string,
  expected: unknown,
): { passed: boolean; reason_short: string } {
  const wantValid = expected === true;
  let parsed = false;
  try {
    JSON.parse(extractJsonText(output));
    parsed = true;
  } catch {
    parsed = false;
  }
  if (wantValid) {
    return parsed
      ? { passed: true, reason_short: "valid JSON" }
      : { passed: false, reason_short: "invalid JSON" };
  }
  return parsed
    ? { passed: false, reason_short: "expected invalid JSON" }
    : { passed: true, reason_short: "invalid JSON as expected" };
}
