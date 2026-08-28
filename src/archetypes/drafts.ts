import { truncateInput, type DraftEval, type ProgramCheck } from "../eval-set.js";
import {
  BUILTIN_ARCHETYPES,
  BUILTIN_ARCHETYPE_IDS,
  REGISTRY_VERSION,
  isBuiltinArchetypeId,
  isCustomArchetypeId,
} from "./registry.js";

type SampleFile = { path: string; content: string };
type LabeledExample = {
  text: string;
  label: string;
  expected: { path: string; value?: unknown };
};
type Evidence = {
  prompts?: Array<{ name?: string; text: string }>;
  schemas?: Array<{
    name?: string;
    schema?: Record<string, unknown>;
    fields?: string[];
  }>;
  tool_schemas?: Array<{
    name: string;
    description?: string;
    schema?: Record<string, unknown>;
  }>;
  source_docs?: Array<{ id: string; text: string }>;
  trace_summaries?: Array<{ id?: string; text: string; steps?: string[] }>;
  user_notes?: string[];
  labels?: string[];
};
type CustomArchetype = {
  id: string;
  name: string;
  measures: string;
  applies_when: string;
  required_evidence: string[];
  scorer_primitives: string[];
  human_mark_path: string;
  examples: string[];
};
type Limits = {
  needs_images?: boolean;
  modalities?: string[];
  max_wait_ms?: number;
  max_spend_usd_per_1k?: number;
  allowed_models?: string[];
  excluded_models?: string[];
};
type WhatGoodMeans = {
  how_it_should_behave: string;
  success: string;
  must_never: string;
};

export type DraftPlanInput = {
  description?: string;
  sample_files?: SampleFile[];
  labeled_examples?: LabeledExample[];
  archetype_ids?: string[];
  custom_archetypes?: CustomArchetype[];
  evidence?: Evidence;
  limits?: Limits;
  what_good_means?: WhatGoodMeans | null;
};

export type DraftPlan =
  | {
      ok: true;
      drafts: DraftEval[];
      archetypeIdsUsed: string[];
      registryVersion: string;
      archetypePlan: Record<string, unknown>;
    }
  | { ok: false; message: string };

const DRAFTABLE_IDS = BUILTIN_ARCHETYPE_IDS.filter(
  (id) => BUILTIN_ARCHETYPES[id].draftable,
);
const DRAFTABLE_ID_SET = new Set<string>(DRAFTABLE_IDS);

const FIELD_STOP = new Set([
  "a",
  "an",
  "and",
  "as",
  "field",
  "fields",
  "json",
  "object",
  "return",
  "the",
  "to",
  "with",
]);

const ROUTE_PATHS = new Set(["route", "label", "intent", "category", "priority"]);
const DEFAULT_REGION_TOLERANCE = 8;

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

function evidenceText(input: DraftPlanInput): string {
  return [
    input.description,
    input.what_good_means?.how_it_should_behave,
    input.what_good_means?.success,
    input.what_good_means?.must_never,
    ...(input.evidence?.prompts?.map((p) => p.text) ?? []),
    ...(input.evidence?.trace_summaries?.map((t) => t.text) ?? []),
    ...(input.evidence?.user_notes ?? []),
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
}

function normalizeField(raw: string): string | null {
  const clean = raw
    .trim()
    .replace(/\[\]$/u, "")
    .replace(/[^a-zA-Z0-9_]/gu, "");
  if (!clean || FIELD_STOP.has(clean.toLowerCase())) {
    return null;
  }
  return clean;
}

function fieldsFromDescription(description: string | undefined): string[] {
  if (!description) {
    return [];
  }
  const out: string[] = [];
  for (const match of description.matchAll(/`([a-zA-Z_][a-zA-Z0-9_]*(?:\[\])?)`/g)) {
    const field = normalizeField(match[1] ?? "");
    if (field) {
      out.push(field);
    }
  }
  for (const match of description.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*\[\])/g)) {
    const field = normalizeField(match[1] ?? "");
    if (field) {
      out.push(field);
    }
  }
  const withMatch = /\bwith\s+([^.;]+)/i.exec(description);
  if (withMatch) {
    const parts = withMatch[1]!.split(/,|\band\b/i);
    for (const part of parts) {
      if (!/[_\[]/.test(part)) {
        continue;
      }
      const token = part.trim().match(/[a-zA-Z_][a-zA-Z0-9_]*/)?.[0] ?? "";
      const field = normalizeField(token);
      if (field) {
        out.push(field);
      }
    }
  }
  if (/\b(extract|field|fields|named fields)\b/i.test(description)) {
    const fieldText = description
      .replace(/^.*?\bfields?\b/i, "")
      .split(/\bfrom\b/i)[0] ?? "";
    for (const part of fieldText.split(/,|\band\b/i)) {
      const token = part.trim().match(/[a-zA-Z_][a-zA-Z0-9_]*/)?.[0] ?? "";
      const field = normalizeField(token);
      if (field) {
        out.push(field);
      }
    }
  }
  return uniq(out);
}

function fieldsFromSchema(schema: Record<string, unknown> | undefined): string[] {
  if (!schema) {
    return [];
  }
  const out: string[] = [];
  const props = schema.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    out.push(...Object.keys(props));
  }
  const required = schema.required;
  if (Array.isArray(required)) {
    out.push(...required.filter((v): v is string => typeof v === "string"));
  }
  return uniq(out);
}

function fieldsFromEvidence(input: DraftPlanInput): string[] {
  const out: string[] = [];
  for (const schema of input.evidence?.schemas ?? []) {
    out.push(...(schema.fields ?? []));
    out.push(...fieldsFromSchema(schema.schema));
  }
  if ((input.sample_files?.length ?? 0) > 0) {
    for (const file of input.sample_files ?? []) {
      const parsed = parseJson(file.content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(...Object.keys(parsed));
      }
    }
  }
  out.push(...fieldsFromDescription(input.description));
  return uniq(out.map((field) => normalizeField(field) ?? "").filter(Boolean));
}

function parseJson(text: string): unknown | null {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(trimmed);
  try {
    return JSON.parse(fence ? fence[1]!.trim() : trimmed) as unknown;
  } catch {
    return null;
  }
}

function firstSchema(input: DraftPlanInput): Record<string, unknown> | null {
  return input.evidence?.schemas?.find((s) => s.schema)?.schema ?? null;
}

function hasImageOrPdf(input: DraftPlanInput): boolean {
  return (
    input.limits?.needs_images === true ||
    input.limits?.modalities?.includes("image") === true ||
    input.sample_files?.some((f) => /\.(png|jpe?g|gif|webp|pdf)$/i.test(f.path)) === true
  );
}

function hasLimits(input: DraftPlanInput): boolean {
  const limits = input.limits;
  return Boolean(
    limits?.max_wait_ms != null ||
      limits?.max_spend_usd_per_1k != null ||
      (limits?.allowed_models?.length ?? 0) > 0 ||
      (limits?.excluded_models?.length ?? 0) > 0,
  );
}

function draft(
  archetypeId: string,
  title: string,
  inputText: string,
  programCheck: ProgramCheck | null,
  opts?: {
    form_type?: DraftEval["form_type"];
    form_spec?: Record<string, unknown>;
    evidence_json?: Record<string, unknown>;
  },
): DraftEval {
  return {
    title,
    score_how: programCheck ? "code" : "person",
    status: "draft",
    program_check: programCheck,
    input_truncated: truncateInput(inputText),
    form_type: opts?.form_type,
    form_spec: opts?.form_spec,
    archetype_id: archetypeId,
    scorer_primitive: programCheck?.kind ?? null,
    evidence_json: opts?.evidence_json ?? evidenceSummary(archetypeId, {}),
  };
}

function evidenceSummary(
  archetypeId: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return { archetype_id: archetypeId, ...extra };
}

function sampleInput(input: DraftPlanInput): string {
  return (
    input.description ??
    input.evidence?.prompts?.[0]?.text ??
    input.evidence?.user_notes?.join("\n") ??
    JSON.stringify(input.what_good_means ?? {})
  );
}

function routePath(examples: LabeledExample[]): string {
  return examples.find((e) => ROUTE_PATHS.has(e.expected.path))?.expected.path ?? "label";
}

function examplesToDrafts(input: DraftPlanInput): DraftEval[] {
  const examples = input.labeled_examples ?? [];
  if (examples.length === 0) {
    return [];
  }
  const routeLike =
    input.archetype_ids?.includes("classification_route") === true ||
    examples.some((e) => ROUTE_PATHS.has(e.expected.path));
  return examples.map((example) => {
    const archetypeId = routeLike ? "classification_route" : "extraction_transform";
    return draft(
      archetypeId,
      example.text,
      example.text,
      {
        kind: "field_equals",
        expected: {
          path: routeLike ? example.expected.path || routePath(examples) : example.expected.path,
          value: example.expected.value,
        },
      },
      {
        form_type: "pass_fail",
        form_spec: { text: example.text, label: example.label },
        evidence_json: evidenceSummary(archetypeId, {
          label: example.label,
          expected_path: example.expected.path,
        }),
      },
    );
  });
}

function outputContractDrafts(input: DraftPlanInput): DraftEval[] {
  const inputText = sampleInput(input);
  const schema = firstSchema(input);
  const fields = fieldsFromEvidence(input);
  const out: DraftEval[] = [
    draft("output_contract", "Output is valid JSON", inputText, {
      kind: "json_valid",
      expected: true,
    }),
  ];
  if (schema) {
    out.push(
      draft("output_contract", "Output matches JSON schema", inputText, {
        kind: "json_schema",
        expected: schema,
      }),
    );
  }
  for (const field of fields) {
    out.push(
      draft("output_contract", `Field ${field} is present`, inputText, {
        kind: "field_equals",
        expected: { path: field, exists: true },
      }),
    );
    const lowerField = field.toLowerCase();
    if (lowerField === "line_items") {
      out.push(
        draft("output_contract", "Field line_items is an array", inputText, {
          kind: "field_equals",
          expected: { path: field, exists: true, type: "array" },
        }),
      );
    }
    if (
      lowerField === "total_cents" ||
      lowerField === "totalcents" ||
      lowerField === "amount" ||
      lowerField === "total"
    ) {
      out.push(
        draft("output_contract", `Field ${field} is numeric`, inputText, {
          kind: "field_equals",
          expected: { path: field, exists: true, type: "number" },
        }),
      );
    }
  }
  for (const file of input.sample_files ?? []) {
    if (parseJson(file.content) === null) {
      continue;
    }
    out.push(
      draft("output_contract", `Sample ${file.path}`, file.content, {
        kind: "json_valid",
        expected: true,
      }),
    );
  }
  out.push(
    draft("output_contract", "Must not wrap JSON in markdown", inputText, {
      kind: "must_not_contain",
      expected: "```",
    }),
  );
  return out;
}

function extractionDrafts(input: DraftPlanInput): DraftEval[] {
  const inputText = sampleInput(input);
  const fields = fieldsFromEvidence(input);
  if (fields.length === 0) {
    if (hasImageOrPdf(input) || /\bextract\b/i.test(inputText)) {
      const needsRegion = /\b(location|region|bounding box|where)\b/i.test(inputText);
      return [
        draft("extraction_transform", "Extract fields", inputText, null, {
          form_type: needsRegion ? "pass_fail" : "fields",
          form_spec: needsRegion
            ? { needs_region: true, region_tolerance: DEFAULT_REGION_TOLERANCE }
            : { fields: [] },
        }),
      ];
    }
    return [];
  }
  return fields.map((field) =>
    draft("extraction_transform", `Field ${field} is present`, inputText, {
      kind: "field_equals",
      expected: { path: field, exists: true },
    }),
  );
}

function classificationDrafts(input: DraftPlanInput): DraftEval[] {
  const labeled = examplesToDrafts({
    ...input,
    archetype_ids: ["classification_route"],
  });
  if (labeled.length > 0) {
    return labeled;
  }
  const labels = input.evidence?.labels ?? [];
  const inputText = sampleInput(input);
  if (labels.length > 0) {
    return [
      draft("classification_route", "Route is an allowed label", inputText, {
        kind: "json_schema",
        expected: {
          type: "object",
          required: ["label"],
          properties: { label: { enum: labels } },
        },
      }),
    ];
  }
  if (/\b(classify|route|label|intent)\b/i.test(inputText)) {
    return [
      draft("classification_route", "Route choice", inputText, null, {
        form_type: "pass_fail",
        form_spec: { labels },
      }),
    ];
  }
  return [];
}

function toolCallDrafts(input: DraftPlanInput): DraftEval[] {
  const tools = input.evidence?.tool_schemas ?? [];
  const inputText = sampleInput(input);
  if (tools.length === 1) {
    return [
      draft("tool_call", `Calls ${tools[0]!.name}`, inputText, {
        kind: "tool_args",
        expected: { name: tools[0]!.name },
      }),
    ];
  }
  if (tools.length > 1 || /\b(tool|function call|call a function)\b/i.test(inputText)) {
    return [
      draft("tool_call", "Tool choice", inputText, null, {
        form_type: "tool",
        form_spec: { tools: tools.map((tool) => tool.name) },
      }),
    ];
  }
  return [];
}

function toolResultUseDrafts(input: DraftPlanInput): DraftEval[] {
  const inputText = sampleInput(input);
  const fields = fieldsFromEvidence(input);
  if (fields.length > 0 && /\b(tool result|returned data|account data|state)\b/i.test(inputText)) {
    return fields.map((field) =>
      draft("tool_result_use", `Uses returned field ${field}`, inputText, {
        kind: "field_equals",
        expected: { path: field, exists: true },
      }),
    );
  }
  if (/\b(tool result|returned data|state)\b/i.test(inputText)) {
    return [
      draft("tool_result_use", "Uses returned tool data", inputText, null, {
        form_type: "pass_fail",
      }),
    ];
  }
  return [];
}

function sourcePhrase(text: string): string {
  const words = text
    .replace(/\s+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2)
    .slice(0, 8);
  return words.join(" ");
}

function ragDrafts(input: DraftPlanInput): DraftEval[] {
  const docs = input.evidence?.source_docs ?? [];
  if (docs.length === 0) {
    return [];
  }
  const required = docs.map((doc) => sourcePhrase(doc.text)).filter(Boolean);
  return [
    draft("rag_retrieval", "Retrieved context includes required source facts", sampleInput(input), {
      kind: "retrieval_contains",
      expected: { required, mode: "any" },
    }),
  ];
}

function groundedDrafts(input: DraftPlanInput): DraftEval[] {
  const docs = input.evidence?.source_docs ?? [];
  if (docs.length === 0) {
    return [];
  }
  const required = docs.map((doc) => sourcePhrase(doc.text)).filter(Boolean);
  return [
    draft("grounded_answer", "Answer uses supplied source facts", sampleInput(input), {
      kind: "retrieval_contains",
      expected: { required, mode: "any" },
    }),
  ];
}

function citationDrafts(input: DraftPlanInput): DraftEval[] {
  const docs = input.evidence?.source_docs ?? [];
  if (docs.length === 0) {
    return [];
  }
  return [
    draft("citation_quality", "Answer cites supplied source ids", sampleInput(input), {
      kind: "citation_support",
      expected: { sources: docs.map((doc) => doc.id), require_all: false },
    }),
  ];
}

function mathDrafts(input: DraftPlanInput): DraftEval[] {
  const inputText = sampleInput(input);
  const expected = [
    ...(input.evidence?.user_notes ?? []),
    input.what_good_means?.success ?? "",
  ]
    .join(" ")
    .match(/(?:expected|answer|total|equals?|is)\s+(-?\d+(?:\.\d+)?)/i);
  if (!expected) {
    if (/\b(calculate|math|sum|count|numeric)\b/i.test(inputText)) {
      return [
        draft("math_exact", "Numeric answer", inputText, null, {
          form_type: "pass_fail",
        }),
      ];
    }
    return [];
  }
  return [
    draft("math_exact", "Numeric answer is close", inputText, {
      kind: "numeric_close",
      expected: { value: Number(expected[1]), tolerance: 0 },
    }),
  ];
}

function codeDrafts(input: DraftPlanInput): DraftEval[] {
  const fixture = input.sample_files?.find((file) => /\.(sh|js|mjs|cjs|ts)$/i.test(file.path));
  const inputText = sampleInput(input);
  if (fixture) {
    return [
      draft("code_functional", `Fixture ${fixture.path}`, inputText, {
        kind: "fixture",
        expected: { path: fixture.path },
      }),
    ];
  }
  if (/\b(code|function|patch|repo|program)\b/i.test(inputText)) {
    return [
      draft("code_functional", "Code satisfies product behavior", inputText, null, {
        form_type: "pass_fail",
      }),
    ];
  }
  return [];
}

function conversationDrafts(input: DraftPlanInput): DraftEval[] {
  const inputText = sampleInput(input);
  if (!/\b(conversation|multi-turn|support|customer|chat|tone|warm|friendly|good reply|subjective|fuzzy)\b/i.test(inputText)) {
    return [];
  }
  return [
    draft("conversation_task", "Conversation goal is complete", inputText, null, {
      form_type: "rubric",
      form_spec: { rubric: ["goal_complete", "policy_followed"] },
    }),
  ];
}

function trajectoryDrafts(input: DraftPlanInput): DraftEval[] {
  const traces = input.evidence?.trace_summaries ?? [];
  const inputText = sampleInput(input);
  if (traces.length > 0) {
    const required = traces.flatMap((trace) => trace.steps ?? []);
    return [
      draft("agent_trajectory", "Trace follows required steps", inputText, {
        kind: "trace_rule",
        expected: { must_include: required.length > 0 ? required : [traces[0]!.text] },
      }),
    ];
  }
  if (/\b(step|trace|sequence|before final|tool order)\b/i.test(inputText)) {
    return [
      draft("agent_trajectory", "Agent steps follow the rule", inputText, null, {
        form_type: "pass_fail",
      }),
    ];
  }
  return [];
}

function safetyDrafts(input: DraftPlanInput): DraftEval[] {
  const inputText = sampleInput(input);
  const mustNever = input.what_good_means?.must_never;
  if (mustNever && mustNever.trim().length > 0) {
    return [
      draft("safety_policy", "Must not include prohibited content", inputText, {
        kind: "must_not_contain",
        expected: mustNever,
      }),
    ];
  }
  if (/\b(safety|refuse|secret|token|prompt injection|private)\b/i.test(inputText)) {
    return [
      draft("safety_policy", "Safety policy decision", inputText, null, {
        form_type: "pass_fail",
      }),
    ];
  }
  return [];
}

function fairnessDrafts(input: DraftPlanInput): DraftEval[] {
  const inputText = sampleInput(input);
  const fields = fieldsFromEvidence(input);
  if (fields.length >= 2) {
    return [
      draft("fairness_invariance", "Paired fields stay equal", inputText, {
        kind: "pairwise_equals",
        expected: { pairs: [{ left_path: fields[0], right_path: fields[1] }] },
      }),
    ];
  }
  if (/\b(fair|bias|invariant|protected attribute|paired)\b/i.test(inputText)) {
    return [
      draft("fairness_invariance", "Paired examples are invariant", inputText, null, {
        form_type: "pass_fail",
      }),
    ];
  }
  return [];
}

function customDrafts(input: DraftPlanInput, id: string): DraftEval[] {
  const custom = input.custom_archetypes?.find((a) => a.id === id);
  if (!custom) {
    return [];
  }
  return [
    draft(id, custom.name, sampleInput(input), null, {
      form_type: "rubric",
      form_spec: { rubric: [custom.measures] },
      evidence_json: evidenceSummary(id, {
        required_evidence: custom.required_evidence,
        scorer_primitives: custom.scorer_primitives,
      }),
    }),
  ];
}

function builtInDrafts(input: DraftPlanInput, id: string): DraftEval[] {
  switch (id) {
    case "output_contract":
      return outputContractDrafts(input);
    case "extraction_transform":
      return extractionDrafts(input);
    case "classification_route":
      return classificationDrafts(input);
    case "tool_call":
      return toolCallDrafts(input);
    case "tool_result_use":
      return toolResultUseDrafts(input);
    case "rag_retrieval":
      return ragDrafts(input);
    case "grounded_answer":
      return groundedDrafts(input);
    case "citation_quality":
      return citationDrafts(input);
    case "math_exact":
      return mathDrafts(input);
    case "code_functional":
      return codeDrafts(input);
    case "conversation_task":
      return conversationDrafts(input);
    case "agent_trajectory":
      return trajectoryDrafts(input);
    case "safety_policy":
      return safetyDrafts(input);
    case "fairness_invariance":
      return fairnessDrafts(input);
    case "cost_latency_fit":
      return [];
    default:
      return [];
  }
}

function detectArchetypes(input: DraftPlanInput): string[] {
  const text = evidenceText(input);
  const ids: string[] = [];
  const fields = fieldsFromEvidence(input);
  if (/\bjson\b/i.test(text) || firstSchema(input) != null) {
    ids.push("output_contract");
  }
  if (/\bextract|normalize|parse|read\b/i.test(text) && fields.length > 0) {
    ids.push("extraction_transform");
  }
  if (hasImageOrPdf(input) && /\b(judge|judgment|readable|appropriate)\b/i.test(text)) {
    ids.push("extraction_transform");
  }
  if (/\bclassify|route|label|intent\b/i.test(text) || (input.evidence?.labels?.length ?? 0) > 0) {
    ids.push("classification_route");
  }
  if ((input.evidence?.tool_schemas?.length ?? 0) > 0 || /\btool|function call\b/i.test(text)) {
    ids.push("tool_call");
  }
  if (/\btool result|returned data|account data|state\b/i.test(text)) {
    ids.push("tool_result_use");
  }
  if ((input.evidence?.source_docs?.length ?? 0) > 0 && /\bretrieve|search|context\b/i.test(text)) {
    ids.push("rag_retrieval");
  }
  if ((input.evidence?.source_docs?.length ?? 0) > 0 && /\bgrounded|source|answer|summarize\b/i.test(text)) {
    ids.push("grounded_answer");
  }
  if ((input.evidence?.source_docs?.length ?? 0) > 0 && /\bcite|citation|source id\b/i.test(text)) {
    ids.push("citation_quality");
  }
  if (/\b(calculate|math|sum|count|numeric)\b/i.test(text)) {
    ids.push("math_exact");
  }
  if (/\bcode|function|patch|repo|program\b/i.test(text)) {
    ids.push("code_functional");
  }
  if (/\bconversation|multi-turn|support|customer|chat|tone|warm|friendly|good reply|subjective|fuzzy\b/i.test(text)) {
    ids.push("conversation_task");
  }
  if ((input.evidence?.trace_summaries?.length ?? 0) > 0 || /\btrace|step|sequence|tool order\b/i.test(text)) {
    ids.push("agent_trajectory");
  }
  if (input.what_good_means?.must_never || /\bsafety|refuse|secret|token|prompt injection|private\b/i.test(text)) {
    ids.push("safety_policy");
  }
  if (/\bfair|bias|invariant|protected attribute|paired\b/i.test(text)) {
    ids.push("fairness_invariance");
  }
  if (hasLimits(input)) {
    ids.push("cost_latency_fit");
  }
  return uniq(ids);
}

function validateRequested(input: DraftPlanInput): string | null {
  const customIds = new Set(input.custom_archetypes?.map((a) => a.id) ?? []);
  for (const id of input.archetype_ids ?? []) {
    if (isBuiltinArchetypeId(id)) {
      continue;
    }
    if (isCustomArchetypeId(id) && customIds.has(id)) {
      continue;
    }
    return `Unknown archetype id ${id}`;
  }
  return null;
}

export function buildDraftPlan(input: DraftPlanInput): DraftPlan {
  const requestedError = validateRequested(input);
  if (requestedError) {
    return { ok: false, message: requestedError };
  }

  const forced = input.archetype_ids ?? [];
  const detected = forced.length > 0 ? forced : detectArchetypes(input);
  const ids = uniq(detected);
  if (input.labeled_examples && input.labeled_examples.length > 0 && ids.length === 0) {
    ids.push("extraction_transform");
  }

  const drafts =
    input.labeled_examples && input.labeled_examples.length > 0 && forced.length === 0
      ? examplesToDrafts(input)
      : ids.flatMap((id) =>
          isCustomArchetypeId(id) ? customDrafts(input, id) : builtInDrafts(input, id),
        );

  const archetypeIdsUsed = uniq([
    ...drafts.map((d) => d.archetype_id ?? "").filter(Boolean),
    ...ids.filter((id) => id === "cost_latency_fit" && hasLimits(input)),
  ]);

  if (drafts.length === 0) {
    return {
      ok: true,
      drafts: [],
      archetypeIdsUsed,
      registryVersion: REGISTRY_VERSION,
      archetypePlan: {
        requested: forced,
        detected: ids,
        no_drafts: ids.filter((id) => !DRAFTABLE_ID_SET.has(id)),
      },
    };
  }

  return {
    ok: true,
    drafts,
    archetypeIdsUsed,
    registryVersion: REGISTRY_VERSION,
    archetypePlan: {
      requested: forced,
      detected: ids,
      drafted: archetypeIdsUsed.filter((id) => id !== "cost_latency_fit"),
      no_drafts: archetypeIdsUsed.filter((id) => id === "cost_latency_fit"),
    },
  };
}
