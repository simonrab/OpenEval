import {
  truncateInput,
  type DraftEval,
} from "../eval-set.js";

const DEMO_PROMPT =
  "Return JSON with line_items[] and total_cents for this invoice.";

export function isJsonObjectJob(description: string | undefined): boolean {
  if (!description) {
    return false;
  }
  const d = description.toLowerCase();
  if (d.includes("line_items")) {
    return true;
  }
  if (d.includes("total_cents")) {
    return true;
  }
  if (d.includes("invoice")) {
    return true;
  }
  if (/return\s+json\s+with/i.test(description)) {
    return true;
  }
  if (/json object/i.test(description)) {
    return true;
  }
  return false;
}

function looksLikeJson(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function jsonObjectDrafts(opts: {
  description: string;
  sampleFiles?: Array<{ path: string; content: string }>;
}): DraftEval[] {
  const input = truncateInput(opts.description || DEMO_PROMPT);
  const drafts: DraftEval[] = [
    {
      title: "Output is valid JSON",
      score_how: "code",
      status: "draft",
      program_check: { kind: "json_valid", expected: true },
      input_truncated: input,
    },
    {
      title: "JSON has line_items[]",
      score_how: "code",
      status: "draft",
      program_check: {
        kind: "field_equals",
        expected: { path: "line_items", exists: true, type: "array" },
      },
      input_truncated: input,
    },
    {
      title: "JSON has total_cents",
      score_how: "code",
      status: "draft",
      program_check: {
        kind: "field_equals",
        expected: { path: "total_cents", exists: true },
      },
      input_truncated: input,
    },
    {
      title: "Must not wrap JSON in markdown",
      score_how: "code",
      status: "draft",
      program_check: { kind: "must_not_contain", expected: "```" },
      input_truncated: input,
    },
  ];

  for (const file of opts.sampleFiles ?? []) {
    drafts.push({
      title: `Sample ${file.path}`,
      score_how: "code",
      status: "draft",
      program_check: looksLikeJson(file.content)
        ? { kind: "json_valid", expected: true }
        : { kind: "fixture", expected: { path: file.path } },
      input_truncated: truncateInput(file.content),
    });
  }

  return drafts;
}
