export const REGISTRY_VERSION = "evalrouter-archetypes-v1";

export const BUILTIN_ARCHETYPE_IDS = [
  "output_contract",
  "extraction_transform",
  "classification_route",
  "tool_call",
  "tool_result_use",
  "rag_retrieval",
  "grounded_answer",
  "citation_quality",
  "math_exact",
  "code_functional",
  "conversation_task",
  "agent_trajectory",
  "safety_policy",
  "fairness_invariance",
  "cost_latency_fit",
] as const;

export type BuiltinArchetypeId = (typeof BUILTIN_ARCHETYPE_IDS)[number];

export type ScorerPrimitive =
  | "json_valid"
  | "tool_name"
  | "field_equals"
  | "must_not_contain"
  | "fixture"
  | "json_schema"
  | "regex_match"
  | "numeric_close"
  | "set_equals"
  | "tool_args"
  | "trace_rule"
  | "citation_support"
  | "retrieval_contains"
  | "pairwise_equals"
  | "run_metric";

export type ArchetypeDefinition = {
  id: BuiltinArchetypeId;
  name: string;
  measures: string;
  appliesWhen: string;
  requiredEvidence: string[];
  scorerPrimitives: ScorerPrimitive[];
  humanMarkPath: string;
  examples: string[];
  draftable: boolean;
};

const definitions: ArchetypeDefinition[] = [
  {
    id: "output_contract",
    name: "Output contract",
    measures: "Output shape and forbidden wrappers.",
    appliesWhen: "The job returns JSON, a schema, or a fixed text format.",
    requiredEvidence: ["prompt", "schema or field list"],
    scorerPrimitives: [
      "json_valid",
      "json_schema",
      "field_equals",
      "regex_match",
      "must_not_contain",
    ],
    humanMarkPath: "Use person mark only when the format rule is ambiguous.",
    examples: ["Output is JSON and has total_cents."],
    draftable: true,
  },
  {
    id: "extraction_transform",
    name: "Extraction transform",
    measures: "Field extraction and normalization.",
    appliesWhen: "The job extracts data from text, images, or files.",
    requiredEvidence: ["source", "fields", "expected values or rules"],
    scorerPrimitives: ["field_equals", "numeric_close", "set_equals", "fixture"],
    humanMarkPath: "Use a fields form when no single right JSON exists.",
    examples: ["Extract vendor, date, and amount."],
    draftable: true,
  },
  {
    id: "classification_route",
    name: "Classification route",
    measures: "Label, route, or intent choice.",
    appliesWhen: "The job chooses one label from a closed set.",
    requiredEvidence: ["labels", "policy", "examples"],
    scorerPrimitives: ["field_equals", "regex_match", "fixture"],
    humanMarkPath: "Use person mark when the label policy is not clear.",
    examples: ["Route a support message to billing."],
    draftable: true,
  },
  {
    id: "tool_call",
    name: "Tool call",
    measures: "Tool choice and arguments.",
    appliesWhen: "The job must call a tool or choose no tool.",
    requiredEvidence: ["tool schemas", "expected call"],
    scorerPrimitives: ["tool_name", "tool_args", "json_schema"],
    humanMarkPath: "Use person mark when more than one tool is valid.",
    examples: ["Call search with query."],
    draftable: true,
  },
  {
    id: "tool_result_use",
    name: "Tool result use",
    measures: "Use of returned tool data.",
    appliesWhen: "The answer depends on a tool result.",
    requiredEvidence: ["tool result", "expected answer", "state rule"],
    scorerPrimitives: ["field_equals", "set_equals", "fixture", "trace_rule"],
    humanMarkPath: "Use person mark for policy nuance.",
    examples: ["Use account data to answer a refund question."],
    draftable: true,
  },
  {
    id: "rag_retrieval",
    name: "RAG retrieval",
    measures: "Retrieved context relevance and completeness.",
    appliesWhen: "The job must retrieve source context.",
    requiredEvidence: ["query", "source documents", "required facts"],
    scorerPrimitives: ["retrieval_contains", "set_equals", "fixture"],
    humanMarkPath: "Use person mark for domain relevance.",
    examples: ["Retrieve the policy clause that answers the query."],
    draftable: true,
  },
  {
    id: "grounded_answer",
    name: "Grounded answer",
    measures: "Claims that source text supports.",
    appliesWhen: "The answer must stay inside supplied sources.",
    requiredEvidence: ["source text", "answer rules", "required facts"],
    scorerPrimitives: [
      "citation_support",
      "retrieval_contains",
      "must_not_contain",
      "fixture",
    ],
    humanMarkPath: "Use person mark for high-impact claims.",
    examples: ["Answer only from the contract text."],
    draftable: true,
  },
  {
    id: "citation_quality",
    name: "Citation quality",
    measures: "Citation presence and source support.",
    appliesWhen: "The job must cite sources.",
    requiredEvidence: ["source ids", "source text", "citation format"],
    scorerPrimitives: ["citation_support", "regex_match", "retrieval_contains"],
    humanMarkPath: "Use person mark when support is a domain judgment.",
    examples: ["Each factual claim cites a source id."],
    draftable: true,
  },
  {
    id: "math_exact",
    name: "Math exact",
    measures: "Numeric answer and tolerance.",
    appliesWhen: "The job calculates, counts, or compares numbers.",
    requiredEvidence: ["problem", "expected answer", "tolerance"],
    scorerPrimitives: ["numeric_close", "field_equals", "fixture"],
    humanMarkPath: "Use person mark for proof quality.",
    examples: ["Total is 104.35 USD."],
    draftable: true,
  },
  {
    id: "code_functional",
    name: "Code functional",
    measures: "Code behavior from a repo fixture.",
    appliesWhen: "The job writes code, patches code, or returns executable code.",
    requiredEvidence: ["repo command or fixture script"],
    scorerPrimitives: ["fixture", "regex_match", "must_not_contain"],
    humanMarkPath: "Use person mark when product intent is not in the fixture.",
    examples: ["Generated code passes a fixture script."],
    draftable: true,
  },
  {
    id: "conversation_task",
    name: "Conversation task",
    measures: "Multi-turn task completion.",
    appliesWhen: "The job must complete a conversation goal.",
    requiredEvidence: ["conversation script", "hidden facts", "success state"],
    scorerPrimitives: ["trace_rule", "field_equals", "fixture"],
    humanMarkPath: "Use person mark for fuzzy task success.",
    examples: ["Resolve a support request."],
    draftable: true,
  },
  {
    id: "agent_trajectory",
    name: "Agent trajectory",
    measures: "Steps, tool order, and action limits.",
    appliesWhen: "The job has required or forbidden steps.",
    requiredEvidence: ["trace summary", "step rules"],
    scorerPrimitives: ["trace_rule", "tool_name", "fixture"],
    humanMarkPath: "Use person mark when alternate plans are valid.",
    examples: ["Use search before the final answer."],
    draftable: true,
  },
  {
    id: "safety_policy",
    name: "Safety policy",
    measures: "Refusal, safe completion, and secret safety.",
    appliesWhen: "The job has safety or policy limits.",
    requiredEvidence: ["policy", "attack examples", "benign examples"],
    scorerPrimitives: ["must_not_contain", "regex_match", "trace_rule", "fixture"],
    humanMarkPath: "Use person mark for borderline policy calls.",
    examples: ["Do not reveal a secret token."],
    draftable: true,
  },
  {
    id: "fairness_invariance",
    name: "Fairness invariance",
    measures: "Same result for paired inputs.",
    appliesWhen: "A protected attribute must not change the answer.",
    requiredEvidence: ["paired examples", "invariant fields"],
    scorerPrimitives: ["pairwise_equals", "field_equals", "fixture"],
    humanMarkPath: "Use person mark for sensitive domain review.",
    examples: ["Same route for paired user messages."],
    draftable: true,
  },
  {
    id: "cost_latency_fit",
    name: "Cost latency fit",
    measures: "Spend, wait, and model eligibility.",
    appliesWhen: "The job has cost, wait, or allowed-model limits.",
    requiredEvidence: ["run limits", "model list"],
    scorerPrimitives: ["run_metric"],
    humanMarkPath: "No mark path.",
    examples: ["Drop models that exceed max wait."],
    draftable: false,
  },
];

export const BUILTIN_ARCHETYPES: Record<BuiltinArchetypeId, ArchetypeDefinition> =
  Object.fromEntries(definitions.map((d) => [d.id, d])) as Record<
    BuiltinArchetypeId,
    ArchetypeDefinition
  >;

export function isBuiltinArchetypeId(id: string): id is BuiltinArchetypeId {
  return (BUILTIN_ARCHETYPE_IDS as readonly string[]).includes(id);
}

export function isCustomArchetypeId(id: string): boolean {
  return /^custom:[a-z0-9][a-z0-9_-]*$/.test(id);
}
