import type { MemberEval, ProgramCheck } from "../eval-set.js";
import { scoreProgramCheck } from "../scoring/index.js";

/**
 * Archetypes whose program checks describe every answer, not one example.
 * An output contract or a safety rule must hold on any live input.
 */
const LIVE_CHECK_ARCHETYPES = new Set(["output_contract", "safety_policy"]);

/**
 * Check kinds that need no expected answer for the input.
 * A field_equals or set_equals check is tied to one example, so it is left out.
 */
const LIVE_CHECK_KINDS = new Set<ProgramCheck["kind"]>([
  "json_valid",
  "json_schema",
  "must_not_contain",
  "length_range",
]);

/** Most checks one policy carries. Live checks run on every answer. */
export const MAX_LIVE_CHECKS = 10;

/** True when a check can run on any live answer. */
export function isLiveCheck(check: ProgramCheck): boolean {
  if (!LIVE_CHECK_KINDS.has(check.kind)) {
    return false;
  }
  if (check.kind === "json_valid") {
    return check.expected === true;
  }
  return true;
}

/**
 * Live checks from trusted code evals in an output contract or safety
 * archetype. Same checks are kept once.
 */
export function deriveLiveChecks(members: MemberEval[]): ProgramCheck[] {
  const out: ProgramCheck[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    if (m.status !== "trusted" || m.score_how !== "code" || !m.program_check) {
      continue;
    }
    if (!m.archetype_id || !LIVE_CHECK_ARCHETYPES.has(m.archetype_id)) {
      continue;
    }
    if (!isLiveCheck(m.program_check)) {
      continue;
    }
    const key = JSON.stringify(m.program_check);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ kind: m.program_check.kind, expected: m.program_check.expected });
    if (out.length >= MAX_LIVE_CHECKS) {
      break;
    }
  }
  return out;
}

export type LiveCheckResult = {
  /** False when there were no checks to run. */
  checked: boolean;
  /** Short reasons for each failed check. Empty when all passed. */
  failed: string[];
};

/** Runs live checks on one answer. Unsafe checks are skipped. */
export function runLiveChecks(
  output: string,
  checks: readonly ProgramCheck[],
): LiveCheckResult {
  const usable = checks.filter(isLiveCheck);
  if (usable.length === 0) {
    return { checked: false, failed: [] };
  }
  const failed: string[] = [];
  for (const check of usable) {
    const result = scoreProgramCheck(output, check);
    if (!result.passed) {
      failed.push(`${check.kind}: ${result.reason_short}`);
    }
  }
  return { checked: true, failed };
}
