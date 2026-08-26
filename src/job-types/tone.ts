import { truncateInput, type DraftEval } from "../eval-set.js";

const TONE_RE = /\b(tone|warm|friendly|good reply)\b/i;

export function isToneJob(description: string | undefined): boolean {
  if (!description) {
    return false;
  }
  return TONE_RE.test(description);
}

export function toneDrafts(opts: { description: string }): DraftEval[] {
  return [
    {
      title: "Tone and reply quality",
      score_how: "person",
      status: "draft",
      program_check: null,
      input_truncated: truncateInput(opts.description),
      form_type: "rubric",
      form_spec: { rubric: ["tone", "length"] },
    },
  ];
}
