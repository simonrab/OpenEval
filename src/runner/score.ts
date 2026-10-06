import type Database from "better-sqlite3";
import type { MemberEval } from "../eval-set.js";
import type { JudgeCallResult } from "../judge/judge.js";
import { isVerdictMark } from "../judge/store.js";
import type { MarkPayload } from "../mark/forms.js";
import { scoreProgramCheck } from "../scoring/index.js";
import { scoreTrustedPersonMark } from "../scoring/person.js";

export type ScorableEval =
  | (MemberEval & { kind: "code" })
  | (MemberEval & { kind: "person"; trusted_mark: string });

/** Prefix of reason_short when a person mark was reused and the output got no real grade. */
export const PERSON_MARK_REUSED = "person mark reused";

/** Trusted evals that a run can score: code evals with a check, person evals with a mark. */
export function scorableEvals(db: Database.Database, members: MemberEval[]): ScorableEval[] {
  const code = members
    .filter((m) => m.status === "trusted" && m.score_how === "code" && m.program_check != null)
    .map((m) => ({ ...m, kind: "code" as const }));
  const markOf = db.prepare(`SELECT trusted_mark FROM evals WHERE id = ?`);
  const person: ScorableEval[] = [];
  for (const m of members) {
    if (m.status !== "trusted" || m.score_how !== "person") {
      continue;
    }
    const row = markOf.get(m.eval_id) as { trusted_mark: string | null } | undefined;
    if (row?.trusted_mark) {
      person.push({ ...m, kind: "person", trusted_mark: row.trusted_mark });
    }
  }
  return [...code, ...person];
}

/** Grades one output with a calibrated judge. Null means no trusted judge. */
export type JudgeFn = (input: string, output: string) => Promise<JudgeCallResult | "cap">;

export type ScoreContext = {
  mustNever?: string;
  judge?: JudgeFn | null;
};

export type ScoreOutcome = {
  passed: boolean;
  reason_short: string;
  /** True when no grade was made, for example the judge call failed. Not a quality fail. */
  error: boolean;
  /** The spend cap stopped the judge call. */
  cap_hit: boolean;
  judge_cost_usd: number;
};

function parseMark(raw: string): MarkPayload | null {
  try {
    return JSON.parse(raw) as MarkPayload;
  } catch {
    return null;
  }
}

function mustNeverHit(output: string, mustNever: string | undefined): boolean {
  return Boolean(mustNever) && output.toLowerCase().includes(mustNever!.toLowerCase());
}

function done(passed: boolean, reason_short: string, judgeCost = 0): ScoreOutcome {
  return { passed, reason_short, error: false, cap_hit: false, judge_cost_usd: judgeCost };
}

/** Score one output. The worker and submit_outputs both use this. */
export async function scoreOutput(
  ev: ScorableEval,
  output: string,
  ctx: ScoreContext = {},
): Promise<ScoreOutcome> {
  if (ev.kind === "code") {
    const r = scoreProgramCheck(output, ev.program_check!);
    return done(r.passed, r.reason_short);
  }
  const mark = parseMark(ev.trusted_mark);
  if (!mark || !isVerdictMark(mark)) {
    // text, fields, and tool marks compare the output with the human answer.
    const r = scoreTrustedPersonMark(output, ev.trusted_mark, ctx.mustNever);
    return done(r.passed, r.reason_short);
  }
  if (mustNeverHit(output, ctx.mustNever)) {
    return done(false, "must_never hit");
  }
  if (ctx.judge) {
    const result = await ctx.judge(ev.input_truncated, output);
    if (result === "cap") {
      return { passed: false, reason_short: "judge not run: spend cap", error: true, cap_hit: true, judge_cost_usd: 0 };
    }
    if (!result.ok) {
      return {
        passed: false,
        reason_short: result.error === "bad_reply" ? "judge reply not valid" : "judge call failed",
        error: true,
        cap_hit: false,
        judge_cost_usd: result.cost_usd,
      };
    }
    return result.verdict === "pass"
      ? done(true, "judge pass", result.cost_usd)
      : done(false, result.reason ? `judge fail: ${result.reason}` : "judge fail", result.cost_usd);
  }
  const legacy = scoreTrustedPersonMark(output, ev.trusted_mark, ctx.mustNever);
  return done(legacy.passed, `${PERSON_MARK_REUSED}: ${legacy.reason_short}`);
}

/** Person evals in these results that a reused mark scored, not a real grade. */
export function countPersonEvalsNotGraded(
  rows: Array<{ eval_id: string; reason_short: string; outcome?: string }>,
): number {
  return new Set(
    rows
      .filter((r) => r.outcome !== "error" && r.reason_short.startsWith(PERSON_MARK_REUSED))
      .map((r) => r.eval_id),
  ).size;
}
