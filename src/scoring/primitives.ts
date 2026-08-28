type ScoreResult = { passed: boolean; reason_short: string };

function parseJson(text: string): unknown | null {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(trimmed);
  try {
    return JSON.parse(fence ? fence[1]!.trim() : trimmed) as unknown;
  } catch {
    return null;
  }
}

function getAtPath(obj: unknown, path: string | undefined): unknown {
  if (!path) {
    return obj;
  }
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

function valueType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  if (Number.isInteger(value)) {
    return "integer";
  }
  return typeof value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string | null {
  const type = schema.type;
  if (typeof type === "string") {
    const actual = valueType(value);
    if (type === "number" && actual === "integer") {
      // Integer is a valid JSON number.
    } else if (actual !== type) {
      return `${path || "value"} type ${actual}, want ${type}`;
    }
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((v) => sameJson(v, value))) {
    return `${path || "value"} is not allowed`;
  }

  if ("const" in schema && !sameJson(schema.const, value)) {
    return `${path || "value"} value mismatch`;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !(key in obj)) {
          return `${path ? `${path}.` : ""}${key} missing`;
        }
      }
    }

    const properties = schema.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [key, child] of Object.entries(properties)) {
        if (key in obj && child && typeof child === "object" && !Array.isArray(child)) {
          const err = validateSchema(
            obj[key],
            child as Record<string, unknown>,
            path ? `${path}.${key}` : key,
          );
          if (err) {
            return err;
          }
        }
      }
    }

    if (schema.additionalProperties === false && properties && typeof properties === "object") {
      const allowed = new Set(Object.keys(properties));
      const extra = Object.keys(obj).find((key) => !allowed.has(key));
      if (extra) {
        return `${path ? `${path}.` : ""}${extra} unexpected`;
      }
    }
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    for (let i = 0; i < value.length; i += 1) {
      const err = validateSchema(
        value[i],
        schema.items as Record<string, unknown>,
        `${path}[${i}]`,
      );
      if (err) {
        return err;
      }
    }
  }

  return null;
}

export function scoreJsonSchema(output: string, expected: unknown): ScoreResult {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    return { passed: false, reason_short: "bad json_schema spec" };
  }
  const value = parseJson(output);
  if (value === null) {
    return { passed: false, reason_short: "invalid JSON" };
  }
  const err = validateSchema(value, expected as Record<string, unknown>, "");
  if (err) {
    return { passed: false, reason_short: err };
  }
  return { passed: true, reason_short: "schema ok" };
}

export function scoreRegexMatch(output: string, expected: unknown): ScoreResult {
  const spec =
    typeof expected === "string"
      ? { pattern: expected }
      : (expected as { pattern?: unknown; flags?: unknown; negate?: unknown } | null);
  if (!spec || typeof spec.pattern !== "string" || spec.pattern.length === 0) {
    return { passed: false, reason_short: "bad regex_match spec" };
  }
  try {
    const re = new RegExp(
      spec.pattern,
      typeof spec.flags === "string" ? spec.flags : undefined,
    );
    const matched = re.test(output);
    const passed = spec.negate === true ? !matched : matched;
    return { passed, reason_short: passed ? "regex ok" : "regex mismatch" };
  } catch {
    return { passed: false, reason_short: "bad regex" };
  }
}

export function scoreNumericClose(output: string, expected: unknown): ScoreResult {
  const spec = expected as {
    path?: unknown;
    value?: unknown;
    tolerance?: unknown;
  } | null;
  if (!spec || typeof spec.value !== "number") {
    return { passed: false, reason_short: "bad numeric_close spec" };
  }
  const parsed = parseJson(output);
  const raw =
    typeof spec.path === "string" && parsed !== null
      ? getAtPath(parsed, spec.path)
      : parsed ?? output.match(/-?\d+(?:\.\d+)?/)?.[0];
  const actual = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(actual)) {
    return { passed: false, reason_short: "numeric value missing" };
  }
  const tolerance = typeof spec.tolerance === "number" ? spec.tolerance : 0;
  const delta = Math.abs(actual - spec.value);
  return {
    passed: delta <= tolerance,
    reason_short: delta <= tolerance ? "numeric ok" : `delta ${delta}`,
  };
}

export function scoreSetEquals(output: string, expected: unknown): ScoreResult {
  const spec = expected as {
    path?: unknown;
    values?: unknown;
    order_matters?: unknown;
  } | null;
  if (!spec || !Array.isArray(spec.values)) {
    return { passed: false, reason_short: "bad set_equals spec" };
  }
  const parsed = parseJson(output);
  const actual =
    parsed !== null && typeof spec.path === "string" ? getAtPath(parsed, spec.path) : parsed;
  if (!Array.isArray(actual)) {
    return { passed: false, reason_short: "array missing" };
  }
  const actualJson = actual.map((v) => JSON.stringify(v));
  const expectedJson = spec.values.map((v) => JSON.stringify(v));
  if (spec.order_matters === true) {
    return {
      passed: sameJson(actualJson, expectedJson),
      reason_short: sameJson(actualJson, expectedJson) ? "set ok" : "set mismatch",
    };
  }
  actualJson.sort();
  expectedJson.sort();
  return {
    passed: sameJson(actualJson, expectedJson),
    reason_short: sameJson(actualJson, expectedJson) ? "set ok" : "set mismatch",
  };
}

function toolPayload(output: string): { name?: string; args?: unknown } | null {
  const parsed = parseJson(output);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const first = Array.isArray(obj.tool_calls) ? obj.tool_calls[0] : obj;
  if (!first || typeof first !== "object") {
    return null;
  }
  const call = first as Record<string, unknown>;
  const name = call.name ?? call.tool_name ?? call.function;
  let args = call.arguments ?? call.args ?? call.parameters;
  if (typeof args === "string") {
    args = parseJson(args);
  }
  return {
    name: typeof name === "string" ? name : undefined,
    args,
  };
}

export function scoreToolArgs(output: string, expected: unknown): ScoreResult {
  const spec = expected as {
    name?: unknown;
    args?: unknown;
    required?: unknown;
  } | null;
  if (!spec || (spec.name == null && spec.args == null && spec.required == null)) {
    return { passed: false, reason_short: "bad tool_args spec" };
  }
  const call = toolPayload(output);
  if (!call) {
    return { passed: false, reason_short: "tool call missing" };
  }
  if (typeof spec.name === "string" && call.name !== spec.name) {
    return { passed: false, reason_short: "tool name mismatch" };
  }
  const args =
    call.args && typeof call.args === "object" && !Array.isArray(call.args)
      ? (call.args as Record<string, unknown>)
      : {};
  if (Array.isArray(spec.required)) {
    for (const key of spec.required) {
      if (typeof key === "string" && !(key in args)) {
        return { passed: false, reason_short: `${key} missing` };
      }
    }
  }
  if (spec.args && typeof spec.args === "object" && !Array.isArray(spec.args)) {
    for (const [key, value] of Object.entries(spec.args)) {
      if (!sameJson(args[key], value)) {
        return { passed: false, reason_short: `${key} mismatch` };
      }
    }
  }
  return { passed: true, reason_short: "tool args ok" };
}

export function scoreTraceRule(output: string, expected: unknown): ScoreResult {
  const spec = expected as {
    must_include?: unknown;
    must_not_include?: unknown;
    ordered?: unknown;
    before?: unknown;
    max_steps?: unknown;
  } | null;
  if (!spec || typeof spec !== "object") {
    return { passed: false, reason_short: "bad trace_rule spec" };
  }
  const text = output.toLowerCase();
  if (Array.isArray(spec.must_include)) {
    for (const item of spec.must_include) {
      if (typeof item === "string" && !text.includes(item.toLowerCase())) {
        return { passed: false, reason_short: `${item} missing` };
      }
    }
  }
  if (Array.isArray(spec.must_not_include)) {
    for (const item of spec.must_not_include) {
      if (typeof item === "string" && text.includes(item.toLowerCase())) {
        return { passed: false, reason_short: `${item} present` };
      }
    }
  }
  if (Array.isArray(spec.ordered)) {
    let pos = -1;
    for (const item of spec.ordered) {
      if (typeof item !== "string") {
        continue;
      }
      const next = text.indexOf(item.toLowerCase(), pos + 1);
      if (next < 0) {
        return { passed: false, reason_short: `${item} out of order` };
      }
      pos = next;
    }
  }
  if (spec.before && typeof spec.before === "object" && !Array.isArray(spec.before)) {
    const before = spec.before as { first?: unknown; second?: unknown };
    if (typeof before.first === "string" && typeof before.second === "string") {
      const first = text.indexOf(before.first.toLowerCase());
      const second = text.indexOf(before.second.toLowerCase());
      if (first < 0 || second < 0 || first > second) {
        return { passed: false, reason_short: "order mismatch" };
      }
    }
  }
  if (typeof spec.max_steps === "number") {
    const parsed = parseJson(output);
    const steps =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { steps?: unknown }).steps)
        ? ((parsed as { steps: unknown[] }).steps.length)
        : output.split(/\n+/).filter((line) => line.trim().length > 0).length;
    if (steps > spec.max_steps) {
      return { passed: false, reason_short: `too many steps: ${steps}` };
    }
  }
  return { passed: true, reason_short: "trace ok" };
}

export function scoreCitationSupport(output: string, expected: unknown): ScoreResult {
  const spec = expected as { sources?: unknown; require_all?: unknown } | null;
  if (!spec || !Array.isArray(spec.sources) || spec.sources.length === 0) {
    return { passed: false, reason_short: "bad citation_support spec" };
  }
  const cited = spec.sources.filter(
    (source): source is string =>
      typeof source === "string" &&
      new RegExp(`(\\[${escapeRe(source)}\\]|\\(${escapeRe(source)}\\)|\\b${escapeRe(source)}\\b)`).test(output),
  );
  const passed = spec.require_all === true ? cited.length === spec.sources.length : cited.length > 0;
  return { passed, reason_short: passed ? "citation ok" : "citation missing" };
}

export function scoreRetrievalContains(output: string, expected: unknown): ScoreResult {
  const spec = expected as { required?: unknown; mode?: unknown } | null;
  if (!spec || !Array.isArray(spec.required) || spec.required.length === 0) {
    return { passed: false, reason_short: "bad retrieval_contains spec" };
  }
  const text = output.toLowerCase();
  const matches = spec.required.filter(
    (item): item is string =>
      typeof item === "string" && text.includes(item.toLowerCase()),
  );
  const passed =
    spec.mode === "any" ? matches.length > 0 : matches.length === spec.required.length;
  return { passed, reason_short: passed ? "retrieval ok" : "required text missing" };
}

export function scorePairwiseEquals(output: string, expected: unknown): ScoreResult {
  const spec = expected as {
    pairs?: unknown;
    case_sensitive?: unknown;
  } | null;
  if (!spec || !Array.isArray(spec.pairs)) {
    return { passed: false, reason_short: "bad pairwise_equals spec" };
  }
  const parsed = parseJson(output);
  if (parsed === null) {
    return { passed: false, reason_short: "invalid JSON" };
  }
  for (const pair of spec.pairs) {
    if (!pair || typeof pair !== "object" || Array.isArray(pair)) {
      return { passed: false, reason_short: "bad pair spec" };
    }
    const p = pair as {
      left_path?: unknown;
      right_path?: unknown;
      left?: unknown;
      right?: unknown;
    };
    const left =
      typeof p.left_path === "string" ? getAtPath(parsed, p.left_path) : p.left;
    const right =
      typeof p.right_path === "string" ? getAtPath(parsed, p.right_path) : p.right;
    if (
      spec.case_sensitive === false &&
      typeof left === "string" &&
      typeof right === "string"
    ) {
      if (left.toLowerCase() !== right.toLowerCase()) {
        return { passed: false, reason_short: "pair mismatch" };
      }
      continue;
    }
    if (!sameJson(left, right)) {
      return { passed: false, reason_short: "pair mismatch" };
    }
  }
  return { passed: true, reason_short: "pairs ok" };
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
