import { parseToolCalls } from "./tool-call.js";

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

  const name = path || "value";
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return `${name} too short`;
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return `${name} too long`;
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `${name} below minimum`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `${name} above maximum`;
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `${name} too few items`;
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `${name} too many items`;
    }
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

/** Limits that keep a bad pattern from running for a long time. */
export const REGEX_MAX_PATTERN_CHARS = 200;
export const REGEX_MAX_INPUT_CHARS = 20_000;
const REGEX_FLAGS = /^[imsu]*$/;
// Nested quantifiers such as (a+)+ can backtrack for a very long time.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

/** Returns why a regex_match pattern is unsafe, or null when it is safe. */
export function unsafeRegexReason(pattern: string, flags?: string): string | null {
  if (pattern.length === 0) {
    return "empty pattern";
  }
  if (pattern.length > REGEX_MAX_PATTERN_CHARS) {
    return "pattern too long";
  }
  if (flags != null && !REGEX_FLAGS.test(flags)) {
    return "bad regex flags";
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    return "nested quantifier";
  }
  if (/\\[1-9]/.test(pattern)) {
    return "backreference";
  }
  try {
    new RegExp(pattern, flags);
  } catch {
    return "bad regex";
  }
  return null;
}

function textAtPath(output: string, path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) {
    return output;
  }
  const parsed = parseJson(output);
  if (parsed === null) {
    return null;
  }
  const value = getAtPath(parsed, path);
  if (value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function scoreRegexMatch(output: string, expected: unknown): ScoreResult {
  const spec =
    typeof expected === "string"
      ? { pattern: expected }
      : (expected as {
          pattern?: unknown;
          flags?: unknown;
          negate?: unknown;
          path?: unknown;
        } | null);
  if (!spec || typeof spec.pattern !== "string" || spec.pattern.length === 0) {
    return { passed: false, reason_short: "bad regex_match spec" };
  }
  const flags = typeof spec.flags === "string" ? spec.flags : undefined;
  const unsafe = unsafeRegexReason(spec.pattern, flags);
  if (unsafe) {
    return { passed: false, reason_short: unsafe };
  }
  const text = textAtPath(output, spec.path);
  if (text === null) {
    return { passed: false, reason_short: `${String(spec.path)} missing` };
  }
  if (text.length > REGEX_MAX_INPUT_CHARS) {
    return { passed: false, reason_short: "output too long for regex" };
  }
  const matched = new RegExp(spec.pattern, flags).test(text);
  const passed = spec.negate === true ? !matched : matched;
  return { passed, reason_short: passed ? "regex ok" : "regex mismatch" };
}

function roundDelta(delta: number): string {
  return Number(delta.toPrecision(4)).toString();
}

export function scoreNumericClose(output: string, expected: unknown): ScoreResult {
  const spec = expected as {
    path?: unknown;
    value?: unknown;
    tolerance?: unknown;
    abs_tol?: unknown;
    rel_tol?: unknown;
  } | null;
  if (!spec || typeof spec.value !== "number" || !Number.isFinite(spec.value)) {
    return { passed: false, reason_short: "bad numeric_close spec" };
  }
  const parsed = parseJson(output);
  const raw =
    typeof spec.path === "string" && spec.path.length > 0
      ? parsed !== null
        ? getAtPath(parsed, spec.path)
        : undefined
      : typeof parsed === "number"
        ? parsed
        : output.match(/-?\d+(?:\.\d+)?/)?.[0];
  const actual =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(actual)) {
    return { passed: false, reason_short: "numeric value missing" };
  }
  const absTol =
    typeof spec.abs_tol === "number"
      ? spec.abs_tol
      : typeof spec.tolerance === "number"
        ? spec.tolerance
        : 0;
  const relTol = typeof spec.rel_tol === "number" ? spec.rel_tol : 0;
  const allowed = Math.max(absTol, relTol * Math.abs(spec.value));
  const delta = Math.abs(actual - spec.value);
  // A small epsilon absorbs float noise such as 0.1 + 0.2.
  const passed = delta <= allowed + 1e-12;
  return {
    passed,
    reason_short: passed ? "numeric ok" : `delta ${roundDelta(delta)}`,
  };
}

function setKey(value: unknown, caseInsensitive: boolean): string {
  if (caseInsensitive && typeof value === "string") {
    return JSON.stringify(value.trim().toLowerCase());
  }
  return JSON.stringify(value);
}

export function scoreSetEquals(output: string, expected: unknown): ScoreResult {
  const spec = expected as {
    path?: unknown;
    values?: unknown;
    order_matters?: unknown;
    ignore_order?: unknown;
    case_insensitive?: unknown;
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
  const ci = spec.case_insensitive === true;
  const actualKeys = actual.map((v) => setKey(v, ci));
  const expectedKeys = spec.values.map((v) => setKey(v, ci));
  const ordered = spec.order_matters === true || spec.ignore_order === false;
  if (!ordered) {
    actualKeys.sort();
    expectedKeys.sort();
  }
  const ok = sameJson(actualKeys, expectedKeys);
  if (ok) {
    return { passed: true, reason_short: "set ok" };
  }
  const want = new Set(expectedKeys);
  const have = new Set(actualKeys);
  const missing = expectedKeys.filter((k) => !have.has(k)).length;
  const extra = actualKeys.filter((k) => !want.has(k)).length;
  if (missing === 0 && extra === 0) {
    return { passed: false, reason_short: ordered ? "set order mismatch" : "set count mismatch" };
  }
  return { passed: false, reason_short: `set mismatch: ${missing} missing, ${extra} extra` };
}

function stringValues(spec: { values?: unknown } | null): string[] | null {
  if (!spec || !Array.isArray(spec.values) || spec.values.length === 0) {
    return null;
  }
  if (!spec.values.every((v) => typeof v === "string" && v.length > 0)) {
    return null;
  }
  return spec.values as string[];
}

export function scoreContainsAll(output: string, expected: unknown): ScoreResult {
  const spec = expected as { values?: unknown; case_insensitive?: unknown } | null;
  const values = stringValues(spec);
  if (!values) {
    return { passed: false, reason_short: "bad contains_all spec" };
  }
  const ci = spec!.case_insensitive === true;
  const text = ci ? output.toLowerCase() : output;
  const missing = values.filter((v) => !text.includes(ci ? v.toLowerCase() : v));
  if (missing.length === 0) {
    return { passed: true, reason_short: `all ${values.length} present` };
  }
  return { passed: false, reason_short: `${missing.length} of ${values.length} missing` };
}

export function scoreContainsAny(output: string, expected: unknown): ScoreResult {
  const spec = expected as { values?: unknown; case_insensitive?: unknown } | null;
  const values = stringValues(spec);
  if (!values) {
    return { passed: false, reason_short: "bad contains_any spec" };
  }
  const ci = spec!.case_insensitive === true;
  const text = ci ? output.toLowerCase() : output;
  const hit = values.some((v) => text.includes(ci ? v.toLowerCase() : v));
  return hit
    ? { passed: true, reason_short: "one value present" }
    : { passed: false, reason_short: `none of ${values.length} present` };
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

export function scoreLengthRange(output: string, expected: unknown): ScoreResult {
  const spec = expected as {
    min_chars?: unknown;
    max_chars?: unknown;
    min_words?: unknown;
    max_words?: unknown;
  } | null;
  const limits = spec
    ? [spec.min_chars, spec.max_chars, spec.min_words, spec.max_words]
    : [];
  if (
    !spec ||
    limits.every((v) => v === undefined) ||
    limits.some((v) => v !== undefined && (typeof v !== "number" || v < 0))
  ) {
    return { passed: false, reason_short: "bad length_range spec" };
  }
  const chars = output.trim().length;
  const words = countWords(output);
  if (typeof spec.min_chars === "number" && chars < spec.min_chars) {
    return { passed: false, reason_short: `${chars} chars, min ${spec.min_chars}` };
  }
  if (typeof spec.max_chars === "number" && chars > spec.max_chars) {
    return { passed: false, reason_short: `${chars} chars, max ${spec.max_chars}` };
  }
  if (typeof spec.min_words === "number" && words < spec.min_words) {
    return { passed: false, reason_short: `${words} words, min ${spec.min_words}` };
  }
  if (typeof spec.max_words === "number" && words > spec.max_words) {
    return { passed: false, reason_short: `${words} words, max ${spec.max_words}` };
  }
  return { passed: true, reason_short: "length ok" };
}

export function scoreToolArgs(output: string, expected: unknown): ScoreResult {
  const spec = expected as {
    name?: unknown;
    args?: unknown;
    required?: unknown;
    none?: unknown;
  } | null;
  if (
    !spec ||
    (spec.name == null && spec.args == null && spec.required == null && spec.none !== true)
  ) {
    return { passed: false, reason_short: "bad tool_args spec" };
  }
  const calls = parseToolCalls(output) ?? [];
  if (spec.none === true) {
    return calls.length === 0
      ? { passed: true, reason_short: "no tool call, as expected" }
      : { passed: false, reason_short: `unexpected tool call ${calls[0]!.name}` };
  }
  if (calls.length === 0) {
    return { passed: false, reason_short: "tool call missing" };
  }
  const call =
    typeof spec.name === "string" ? calls.find((c) => c.name === spec.name) : calls[0];
  if (!call) {
    return { passed: false, reason_short: `tool name mismatch: ${calls[0]!.name}` };
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
