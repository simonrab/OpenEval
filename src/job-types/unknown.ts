import { truncateInput, type DraftEval, type ProgramCheck } from "../eval-set.js";

const PERSON_RE =
  /\b(tone|good reply|warm|friendly|fuzzy|subjective|feel|judgment)\b/i;
const CODE_RE =
  /\b(json|field|equal|contain|valid|must never|must not|schema|exact|markdown)\b/i;

export function hasPersonSignals(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return PERSON_RE.test(text);
}

function preferCode(text: string): boolean {
  if (PERSON_RE.test(text) && !CODE_RE.test(text)) {
    return false;
  }
  return true;
}

export function personDraftFromText(text: string): DraftEval {
  return {
    title: "Tone and reply quality",
    score_how: "person",
    status: "draft",
    program_check: null,
    input_truncated: truncateInput(text),
  };
}

function titleFrom(prefix: string, text: string): string {
  const combined = `${prefix}: ${text}`.trim();
  if (combined.length <= 80) {
    return combined;
  }
  return `${combined.slice(0, 77)}...`;
}

function guessPath(text: string): string {
  const match = /\b([a-z_][a-z0-9_]*)\b/i.exec(text);
  return match?.[1] ?? "total";
}

function programCheckFromText(text: string): ProgramCheck {
  if (/json/i.test(text) && /valid/i.test(text)) {
    return { kind: "json_valid", expected: true };
  }
  if (/json object/i.test(text) || /return a json/i.test(text)) {
    return { kind: "json_valid", expected: true };
  }
  if (/markdown/i.test(text)) {
    return { kind: "must_not_contain", expected: "```" };
  }
  if (/field/i.test(text) || /total/i.test(text)) {
    return {
      kind: "field_equals",
      expected: { path: guessPath(text), exists: true },
    };
  }
  return { kind: "must_not_contain", expected: text.slice(0, 80) };
}

export type WhatGoodMeans = {
  how_it_should_behave: string;
  success: string;
  must_never: string;
};

export function draftsFromWhatGoodMeans(wgm: WhatGoodMeans): DraftEval[] {
  const behaveCode = preferCode(wgm.how_it_should_behave);
  const successCode = preferCode(wgm.success);

  const drafts: DraftEval[] = [
    {
      title: titleFrom("Behaves", wgm.how_it_should_behave),
      score_how: behaveCode ? "code" : "person",
      status: "draft",
      program_check: behaveCode
        ? programCheckFromText(wgm.how_it_should_behave)
        : null,
      input_truncated: truncateInput(wgm.how_it_should_behave),
    },
    {
      title: titleFrom("Success", wgm.success),
      score_how: successCode ? "code" : "person",
      status: "draft",
      program_check: successCode ? programCheckFromText(wgm.success) : null,
      input_truncated: truncateInput(wgm.success),
    },
    {
      title: titleFrom("Must never", wgm.must_never),
      score_how: "code",
      status: "draft",
      program_check: {
        kind: "must_not_contain",
        expected: wgm.must_never,
      },
      input_truncated: truncateInput(wgm.must_never),
    },
  ];

  return drafts;
}
