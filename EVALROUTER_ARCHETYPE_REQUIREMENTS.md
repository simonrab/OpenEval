# EvalRouter archetype requirements

**Status:** V1 design input  
**Date:** 27 August 2026  
**Audience:** implementers and coding agents

This file defines eval archetypes for EvalRouter V1.
It does not change v0 product truth.
It does not change Live V1 product truth.
It does not change V2 product truth.

An **archetype** is an eval pattern.
It tells the agent what evidence it must give.
It tells EvalRouter which scorer primitives can apply.

A **scorer primitive** is a small program check.
It returns pass or fail for one model output.

A **custom archetype** is a project archetype.
It has an id that starts with `custom:`.

A model-only check is never trusted.
A person mark can trust a person eval.
A deterministic program check can trust a code eval after accept.

## 1. Built-in archetypes

| Id | Measures | Applies when | Required evidence | Scorer primitives | Person mark path | Example |
| --- | --- | --- | --- | --- | --- | --- |
| `output_contract` | Output shape and forbidden wrappers. | The job returns JSON, a schema, or a fixed text format. | Prompt text, schema, or field list. | `json_valid`, `json_schema`, `field_equals`, `regex_match`, `must_not_contain`. | Use person mark only when the format rule is ambiguous. | Output is JSON and has `total_cents`. |
| `extraction_transform` | Field extraction and normalization. | The job extracts data from text, images, or files. | Source text or files, fields, expected values, and normalization rules. | `field_equals`, `numeric_close`, `set_equals`, `fixture`. | Use a fields form when no single right JSON exists. | Extract `vendor`, `date`, and `amount`. |
| `classification_route` | Label, route, or intent choice. | The job chooses one label from a closed set. | Label set, policy, and examples with expected labels. | `field_equals`, `regex_match`, `fixture`. | Use person mark when the label policy is not clear. | Route a support message to `billing`. |
| `tool_call` | Tool choice and arguments. | The job must call a tool or choose no tool. | Tool schemas and expected call data. | `tool_name`, `tool_args`, `json_schema`. | Use person mark when more than one tool is valid. | Call `search` with `query`. |
| `tool_result_use` | Use of returned tool data. | The answer depends on a tool result. | Tool result, expected answer, and state rule. | `field_equals`, `set_equals`, `fixture`, `trace_rule`. | Use person mark for policy nuance. | Use account data to answer a refund question. |
| `rag_retrieval` | Retrieved context relevance and completeness. | The job must retrieve source context. | Query, source documents, and required facts. | `retrieval_contains`, `set_equals`, `fixture`. | Use person mark for domain relevance. | Retrieve the policy clause that answers the query. |
| `grounded_answer` | Claims that source text supports. | The answer must stay inside supplied sources. | Source text, answer rules, and required facts. | `citation_support`, `retrieval_contains`, `must_not_contain`, `fixture`. | Use person mark for high-impact claims. | Answer only from the contract text. |
| `citation_quality` | Citation presence and source support. | The job must cite sources. | Source ids, source text, and citation format. | `citation_support`, `regex_match`, `retrieval_contains`. | Use person mark when support is a legal or domain judgment. | Each factual claim cites a source id. |
| `math_exact` | Numeric answer and tolerance. | The job calculates, counts, or compares numbers. | Problem text, expected answer, unit, and tolerance. | `numeric_close`, `field_equals`, `fixture`. | Use person mark for proof quality. | Total is 104.35 USD. |
| `code_functional` | Code behavior from a repo fixture. | The job writes code, patches code, or returns executable code. | Repo command or fixture script. | `fixture`, `regex_match`, `must_not_contain`. | Use person mark when product intent is not in the fixture. | Generated code passes a fixture script. |
| `conversation_task` | Multi-turn task completion. | The job must complete a conversation goal. | Conversation script, hidden facts, and success state. | `trace_rule`, `field_equals`, `fixture`. | Use person mark for fuzzy task success. | Resolve a support request. |
| `agent_trajectory` | Steps, tool order, and action limits. | The job has required or forbidden steps. | Trace summary and step rules. | `trace_rule`, `tool_name`, `fixture`. | Use person mark when alternate plans are valid. | Use search before the final answer. |
| `safety_policy` | Refusal, safe completion, and secret safety. | The job has safety or policy limits. | Policy text and attack or benign examples. | `must_not_contain`, `regex_match`, `trace_rule`, `fixture`. | Use person mark for borderline policy calls. | Do not reveal a secret token. |
| `fairness_invariance` | Same result for paired inputs. | A protected attribute must not change the answer. | Paired examples and invariant fields. | `pairwise_equals`, `field_equals`, `fixture`. | Use person mark for sensitive domain review. | Same route for paired user messages. |
| `cost_latency_fit` | Spend, wait, and model eligibility. | The job has cost, wait, or allowed-model limits. | Run limits and model list. | Run metrics and hard caps. | No mark path. | Drop models that exceed max wait. |

## 2. Custom project archetypes

A custom archetype id must start with `custom:`.
The id must be stable for the project.
The caller must give the name, measure, applies-when text, required evidence, scorer primitives, mark path, and examples.

EvalRouter can use a custom archetype to draft evals.
It must still validate each program check.
It must route trust with v0 rules.
It must not trust a model-only check.

## 3. Generic trigger-detector pattern

A trigger detector is a project classifier.
It decides if one turn needs a route change or more agent work.
V1 does not define project labels for this pattern.
The coding agent must pass the label set in `evidence.labels`.
The coding agent must pass labeled examples or a policy note.
Use `classification_route` to check the final label.
Use `agent_trajectory` to check required steps before the final answer.
Use `trace_rule` only when the trace summary has the needed steps.
Use a person mark when the policy is not deterministic.
Do not put project names or project labels in EvalRouter code.

## 4. Not V1

V1 does not import public benchmark suites.
V1 does not run browser environments by itself.
V1 does not run operating-system environments by itself.
V1 does not score video by itself.
V1 does not score audio by itself.
V1 does not run live canaries.
V1 does not pick a model for each live request.
V1 does not trust an LLM judge by itself.

Use `fixture` for project work that needs an external harness.
Use a person mark when a deterministic program cannot score the example.
