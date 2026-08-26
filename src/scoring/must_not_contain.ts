export function scoreMustNotContain(
  output: string,
  expected: unknown,
): { passed: boolean; reason_short: string } {
  const needle = String(expected);
  if (output.includes(needle)) {
    return { passed: false, reason_short: `contains "${needle}"` };
  }
  return { passed: true, reason_short: "forbidden text absent" };
}
