import type { DraftEval } from "../eval-set.js";

export type LabeledExample = {
  text: string;
  label: string;
  expected: { path: string; value?: unknown };
};

export function labeledExampleDrafts(examples: LabeledExample[]): DraftEval[] {
  return examples.map((example) => ({
    title: example.text,
    score_how: "code" as const,
    status: "draft" as const,
    program_check: {
      kind: "field_equals" as const,
      expected: {
        path: example.expected.path,
        value: example.expected.value,
      },
    },
    input_truncated: example.text,
    form_type: "pass_fail" as const,
    form_spec: {
      text: example.text,
      label: example.label,
    },
  }));
}
