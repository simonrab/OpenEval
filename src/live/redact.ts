import { createHash } from "node:crypto";
import { truncateInput } from "../eval-set.js";

export const SAMPLE_WHY = ["vendor_error", "timeout", "app_reported"] as const;
export type SampleWhy = (typeof SAMPLE_WHY)[number];

export type LiveSample = {
  sample_id: string;
  project_id: string;
  policy_id: string;
  model_id: string;
  why: SampleWhy;
  input_redacted: string;
  output_redacted: string;
  captured_at: string;
};

export type RedactResult =
  | { ok: true; text: string }
  | { ok: false };

const BEARER_SECRET = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SK_OR_V1 = /\bsk-or-v1-[A-Za-z0-9_-]+\b/g;
const SK_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const AUTHORIZATION = /authorization["'\s:=]+[^\s"',}\]]+/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const CARD = /\b(?:\d[ -]*?){13,19}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

function clone(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

function hashPii(kind: string, value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
  return `[${kind}:${hex}]`;
}

function hasMatch(text: string, pattern: RegExp): boolean {
  return clone(pattern).test(text);
}

function leftoverBearer(text: string): boolean {
  return /Bearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/i.test(text);
}

function stillUnsafe(text: string): boolean {
  if (leftoverBearer(text)) {
    return true;
  }
  if (hasMatch(text, SK_OR_V1) || hasMatch(text, SK_KEY)) {
    return true;
  }
  if (hasMatch(text, EMAIL) || hasMatch(text, PHONE) || hasMatch(text, CARD)) {
    return true;
  }
  if (hasMatch(text, SSN)) {
    return true;
  }
  return false;
}

export function redactLiveText(text: string): RedactResult {
  let out = text
    .replace(clone(BEARER_SECRET), "Bearer [redacted]")
    .replace(clone(SK_OR_V1), "[redacted]")
    .replace(clone(SK_KEY), "[redacted]")
    .replace(clone(AUTHORIZATION), "authorization [redacted]");

  out = out.replace(clone(EMAIL), (match) => hashPii("email", match));
  out = out.replace(clone(PHONE), (match) => hashPii("phone", match));
  out = out.replace(clone(CARD), (match) =>
    hashPii("card", match.replace(/[ -]/g, "")),
  );

  if (stillUnsafe(out)) {
    return { ok: false };
  }
  return { ok: true, text: truncateInput(out) };
}

export function redactSampleFields(
  input: string,
  output: string,
): { ok: true; input_redacted: string; output_redacted: string } | { ok: false } {
  const inputRedacted = redactLiveText(input);
  const outputRedacted = redactLiveText(output);
  if (!inputRedacted.ok || !outputRedacted.ok) {
    return { ok: false };
  }
  return {
    ok: true,
    input_redacted: inputRedacted.text,
    output_redacted: outputRedacted.text,
  };
}
