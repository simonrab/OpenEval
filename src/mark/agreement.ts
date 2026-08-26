import {
  normalizeMarkPayload,
  trimText,
  type MarkPayload,
  type PassFailChoice,
} from "./forms.js";

export type AgreementResult =
  | { agree: true }
  | { agree: false; reason: string };

function samePassFail(a?: PassFailChoice, b?: PassFailChoice): boolean {
  return a === b;
}

function sameRubric(
  a?: Record<string, PassFailChoice>,
  b?: Record<string, PassFailChoice>,
): boolean {
  if (a == null && b == null) {
    return true;
  }
  if (a == null || b == null) {
    return false;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

function sameFields(
  a?: Record<string, string>,
  b?: Record<string, string>,
): boolean {
  if (a == null && b == null) {
    return true;
  }
  if (a == null || b == null) {
    return false;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (trimText(a[key] ?? "") !== trimText(b[key] ?? "")) {
      return false;
    }
  }
  return true;
}

function sameTool(
  a?: { name: string; args: Record<string, unknown> },
  b?: { name: string; args: Record<string, unknown> },
): boolean {
  if (a == null && b == null) {
    return true;
  }
  if (a == null || b == null) {
    return false;
  }
  if (a.name !== b.name) {
    return false;
  }
  return JSON.stringify(a.args) === JSON.stringify(b.args);
}

export function marksAgree(a: MarkPayload, b: MarkPayload): AgreementResult {
  const left = normalizeMarkPayload(a);
  const right = normalizeMarkPayload(b);

  if (left.form_type !== right.form_type) {
    return { agree: false, reason: "form_type differs" };
  }

  switch (left.form_type) {
    case "pass_fail":
      if (!samePassFail(left.pass_fail, right.pass_fail)) {
        return { agree: false, reason: "pass_fail differs" };
      }
      if (
        trimText(left.expected_text ?? "") !== trimText(right.expected_text ?? "")
      ) {
        return { agree: false, reason: "expected_text differs" };
      }
      break;
    case "text":
      if (
        trimText(left.expected_text ?? "") !== trimText(right.expected_text ?? "")
      ) {
        return { agree: false, reason: "expected_text differs" };
      }
      break;
    case "fields":
      if (!sameFields(left.fields, right.fields)) {
        return { agree: false, reason: "fields differ" };
      }
      break;
    case "rubric":
      if (!sameRubric(left.rubric, right.rubric)) {
        return { agree: false, reason: "rubric differs" };
      }
      break;
    case "tool":
      if (!sameTool(left.tool, right.tool)) {
        return { agree: false, reason: "tool differs" };
      }
      break;
    default:
      return { agree: false, reason: "unknown form" };
  }

  return { agree: true };
}
