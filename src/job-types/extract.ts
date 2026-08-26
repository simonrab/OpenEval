import { truncateInput, type DraftEval } from "../eval-set.js";

const STOP = new Set([
  "a",
  "an",
  "and",
  "as",
  "document",
  "each",
  "expected",
  "extract",
  "field",
  "fields",
  "fixed",
  "from",
  "image",
  "invoice",
  "invoices",
  "json",
  "line",
  "messy",
  "named",
  "no",
  "of",
  "or",
  "pdf",
  "read",
  "right",
  "schema",
  "single",
  "the",
  "this",
  "to",
  "value",
  "values",
  "with",
  "without",
]);

const KNOWN_FIELDS = new Set([
  "vendor",
  "total",
  "date",
  "amount",
  "sku",
  "customer",
  "due_date",
]);

export function namedExtractFields(description: string): string[] {
  const found: string[] = [];
  const add = (name: string) => {
    const n = name.toLowerCase();
    if (STOP.has(n) || found.includes(n)) {
      return;
    }
    found.push(n);
  };
  for (const match of description.matchAll(/`([a-z_][a-z0-9_]*)`/gi)) {
    add(match[1]!);
  }
  const tokens = description.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  for (const token of tokens) {
    if (KNOWN_FIELDS.has(token)) {
      add(token);
    }
  }
  return found;
}

export function isExtractJob(description: string | undefined): boolean {
  if (!description) {
    return false;
  }
  const d = description.toLowerCase();
  if (/\bwithout a fixed schema\b/.test(d)) {
    return false;
  }
  const fields = namedExtractFields(description);
  if (fields.length === 0) {
    return false;
  }
  if (/\bextract\b/.test(d)) {
    return true;
  }
  if (/expected value/.test(d)) {
    return true;
  }
  if (/named fields/.test(d)) {
    return true;
  }
  if (fields.includes("vendor") && fields.includes("total")) {
    return true;
  }
  return false;
}

export function extractDrafts(opts: { description: string }): DraftEval[] {
  const fields = namedExtractFields(opts.description);
  const input = truncateInput(opts.description);
  const messy = /no single right json|messy extract/i.test(opts.description);
  if (messy) {
    return [
      {
        title: "Extract named fields",
        score_how: "person",
        status: "draft",
        program_check: null,
        input_truncated: input,
        form_type: "fields",
        form_spec: { fields },
      },
    ];
  }
  return fields.map((path) => ({
    title: `Field ${path} is present`,
    score_how: "code" as const,
    status: "draft" as const,
    program_check: {
      kind: "field_equals" as const,
      expected: { path, exists: true },
    },
    input_truncated: input,
  }));
}
