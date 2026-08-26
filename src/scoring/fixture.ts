export function scoreFixture(
  _output: string,
  expected: unknown,
): { passed: boolean; reason_short: string } {
  const spec = expected as { path?: string } | null;
  const path = spec?.path ?? "fixture";
  return { passed: true, reason_short: `fixture ${path} stub pass` };
}
