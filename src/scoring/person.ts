import type { MarkPayload } from "../mark/forms.js";
import { trimText } from "../mark/forms.js";
import { parseToolCalls } from "./tool-call.js";

export function scoreTrustedPersonMark(
  modelOutput: string,
  trustedMarkJson: string,
  mustNever?: string,
): { passed: boolean; reason_short: string } {
  let mark: MarkPayload;
  try {
    mark = JSON.parse(trustedMarkJson) as MarkPayload;
  } catch {
    return { passed: false, reason_short: "invalid trusted mark" };
  }

  const output = trimText(modelOutput);

  switch (mark.form_type) {
    case "text":
    case "pass_fail": {
      if (mark.expected_text != null && mark.expected_text.length > 0) {
        const expected = trimText(mark.expected_text);
        const ok = output === expected;
        return {
          passed: ok,
          reason_short: ok ? "matches trusted text" : "text mismatch",
        };
      }
      if (mark.pass_fail === "fail") {
        return {
          passed: false,
          reason_short: "trusted mark is fail",
        };
      }
      if (mustNever && output.toLowerCase().includes(mustNever.toLowerCase())) {
        return { passed: false, reason_short: "must_never hit" };
      }
      return { passed: true, reason_short: "person mark pass" };
    }
    case "fields": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        return { passed: false, reason_short: "output not JSON" };
      }
      if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
        return { passed: false, reason_short: "output not object" };
      }
      const obj = parsed as Record<string, unknown>;
      for (const [key, expected] of Object.entries(mark.fields ?? {})) {
        const actual = obj[key];
        if (trimText(String(actual ?? "")) !== trimText(expected)) {
          return { passed: false, reason_short: `field ${key} mismatch` };
        }
      }
      return { passed: true, reason_short: "fields match" };
    }
    case "rubric": {
      for (const [check, choice] of Object.entries(mark.rubric ?? {})) {
        if (choice === "fail") {
          return { passed: false, reason_short: `rubric ${check} fail` };
        }
      }
      if (mustNever && output.toLowerCase().includes(mustNever.toLowerCase())) {
        return { passed: false, reason_short: "must_never hit" };
      }
      return { passed: true, reason_short: "rubric pass" };
    }
    case "tool": {
      const calls = parseToolCalls(output);
      if (calls === null) {
        return { passed: false, reason_short: "output not JSON" };
      }
      const call = mark.tool ? calls.find((c) => c.name === mark.tool!.name) : calls[0];
      if (mark.tool && !call) {
        return { passed: false, reason_short: "tool name mismatch" };
      }
      const args =
        call?.args && typeof call.args === "object" && !Array.isArray(call.args)
          ? (call.args as Record<string, unknown>)
          : {};
      if (mark.tool?.args) {
        for (const [k, v] of Object.entries(mark.tool.args)) {
          if (JSON.stringify(args[k]) !== JSON.stringify(v)) {
            return { passed: false, reason_short: `arg ${k} mismatch` };
          }
        }
      }
      return { passed: true, reason_short: "tool match" };
    }
    default:
      return { passed: false, reason_short: "unknown form" };
  }
}
