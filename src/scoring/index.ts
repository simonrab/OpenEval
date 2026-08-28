import type { ProgramCheck } from "../eval-set.js";
import { scoreFieldEquals } from "./field_equals.js";
import { scoreFixture } from "./fixture.js";
import { scoreJsonValid } from "./json_valid.js";
import { scoreMustNotContain } from "./must_not_contain.js";
import {
  scoreCitationSupport,
  scoreJsonSchema,
  scoreNumericClose,
  scorePairwiseEquals,
  scoreRegexMatch,
  scoreRetrievalContains,
  scoreSetEquals,
  scoreToolArgs,
  scoreTraceRule,
} from "./primitives.js";
import { scoreToolName } from "./tool_name.js";

export type ScoreResult = { passed: boolean; reason_short: string };

export function scoreProgramCheck(
  output: string,
  check: ProgramCheck,
): ScoreResult {
  switch (check.kind) {
    case "json_valid":
      return scoreJsonValid(output, check.expected);
    case "field_equals":
      return scoreFieldEquals(output, check.expected);
    case "must_not_contain":
      return scoreMustNotContain(output, check.expected);
    case "tool_name":
      return scoreToolName(output, check.expected);
    case "fixture":
      return scoreFixture(output, check.expected);
    case "json_schema":
      return scoreJsonSchema(output, check.expected);
    case "regex_match":
      return scoreRegexMatch(output, check.expected);
    case "numeric_close":
      return scoreNumericClose(output, check.expected);
    case "set_equals":
      return scoreSetEquals(output, check.expected);
    case "tool_args":
      return scoreToolArgs(output, check.expected);
    case "trace_rule":
      return scoreTraceRule(output, check.expected);
    case "citation_support":
      return scoreCitationSupport(output, check.expected);
    case "retrieval_contains":
      return scoreRetrievalContains(output, check.expected);
    case "pairwise_equals":
      return scorePairwiseEquals(output, check.expected);
    default:
      return { passed: false, reason_short: "unknown check kind" };
  }
}
