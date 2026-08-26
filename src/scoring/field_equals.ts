import { scoreJsonValid } from "./json_valid.js";

type FieldExpected = {
  path: string;
  exists?: boolean;
  type?: string;
  value?: unknown;
};

function getAtPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function scoreFieldEquals(
  output: string,
  expected: unknown,
): { passed: boolean; reason_short: string } {
  const spec = expected as FieldExpected;
  if (!spec || typeof spec.path !== "string") {
    return { passed: false, reason_short: "bad field_equals spec" };
  }

  const json = scoreJsonValid(output, true);
  if (!json.passed) {
    return { passed: false, reason_short: "invalid JSON" };
  }

  let parsed: unknown;
  try {
    const trimmed = output.trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(trimmed);
    parsed = JSON.parse(fence ? fence[1].trim() : trimmed);
  } catch {
    return { passed: false, reason_short: "invalid JSON" };
  }

  const value = getAtPath(parsed, spec.path);
  if (spec.exists === true && value === undefined) {
    return { passed: false, reason_short: `${spec.path} missing` };
  }
  if (spec.type != null) {
    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (actualType !== spec.type) {
      return {
        passed: false,
        reason_short: `${spec.path} type ${actualType}, want ${spec.type}`,
      };
    }
  }
  if ("value" in spec && spec.value !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(spec.value)) {
      return { passed: false, reason_short: `${spec.path} value mismatch` };
    }
  }
  return { passed: true, reason_short: `${spec.path} ok` };
}
