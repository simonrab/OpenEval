import type Database from "better-sqlite3";
import type { z } from "zod";
import type { ToolHandler } from "../dispatch.js";
import { agentError, projectNotFoundError } from "../errors.js";
import { getIdempotentResponse, storeIdempotentResponse } from "../eval-set.js";
import { projectExists } from "../keys.js";
import { listRunResults, type RunResultRow, type RunRow } from "../runner/queue.js";
import { ensureEvalSplit, lineageRootId } from "../splits.js";
import {
  compareSplit,
  decideVerdict,
  type EvalTally,
  type Objective,
  type Verdict,
} from "../verdict.js";
import {
  candidateNotFoundError,
  loadProjectRun,
  runHasCandidate,
  runIsDone,
  runNotFoundError,
} from "./referee.js";
import { getVerdictOutputSchema, type getVerdictInputSchema } from "./schema.js";
import { ErrorCode, type NextAction } from "./types.js";

type Input = z.infer<typeof getVerdictInputSchema>;

const PLATEAU_ROUNDS = 3;
const FLAT_VERDICTS: ReadonlySet<string> = new Set([
  "within_noise",
  "revert_overfit",
  "revert_regressed",
]);

function percentile50(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length / 2) - 1)] ?? 0;
}

function tallies(rows: RunResultRow[]): Map<string, EvalTally> {
  const out = new Map<string, EvalTally>();
  for (const r of rows) {
    const t = out.get(r.eval_id) ?? { k: 0, n: 0 };
    if (r.outcome === "scored") {
      t.n += 1;
      if (r.passed === 1) t.k += 1;
    }
    out.set(r.eval_id, t);
  }
  return out;
}

function costAndLatency(rows: RunResultRow[]): { costPerCall: number; p50: number } {
  const scored = rows.filter((r) => r.outcome === "scored");
  const cost = rows.reduce((sum, r) => sum + r.cost_usd, 0);
  return {
    costPerCall: scored.length === 0 ? 0 : cost / scored.length,
    p50: percentile50(scored.map((r) => r.time_ms)),
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function notComparableReason(
  baseRun: RunRow,
  candRun: RunRow,
  shared: string[],
  base: Map<string, EvalTally>,
  cand: Map<string, EvalTally>,
): { reason: string; next: NextAction } | null {
  for (const [label, run] of [
    ["baseline", baseRun],
    ["candidate", candRun],
  ] as const) {
    if (!runIsDone(run)) {
      return {
        reason: `The ${label} run is not done.`,
        next: {
          tool: "get_eval_report",
          args: { project_id: run.project_id, run_id: run.id },
          ask_human: null,
        },
      };
    }
  }
  const rerun = (run: RunRow): NextAction => ({
    tool: "run_evals",
    args: { project_id: run.project_id, eval_set_id: run.eval_set_id },
    ask_human: null,
  });
  if (shared.length === 0) {
    return { reason: "The runs have no shared trusted evals.", next: rerun(candRun) };
  }
  for (const [label, run, t] of [
    ["baseline", baseRun, base],
    ["candidate", candRun, cand],
  ] as const) {
    const missing = shared.filter((id) => (t.get(id)?.n ?? 0) === 0).length;
    if (missing > 0) {
      return {
        reason: `${missing} shared evals have no score in the ${label} run. Run the evals again.`,
        next: rerun(run),
      };
    }
  }
  return null;
}

function recordRound(
  db: Database.Database,
  input: Input,
  objective: Objective,
  verdict: Verdict,
): { rounds: number; flatRounds: number } {
  db.prepare(
    `INSERT INTO optimization_rounds
      (project_id, session_id, baseline_run_id, baseline_candidate_id,
       candidate_run_id, candidate_id, objective, verdict, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.project_id,
    input.session_id,
    input.baseline_run_id,
    input.baseline_candidate_id,
    input.candidate_run_id,
    input.candidate_id,
    objective,
    verdict,
    new Date().toISOString(),
  );
  const verdicts = (
    db
      .prepare(
        `SELECT verdict FROM optimization_rounds
         WHERE project_id = ? AND session_id = ? ORDER BY id DESC`,
      )
      .all(input.project_id, input.session_id) as Array<{ verdict: string }>
  ).map((r) => r.verdict);
  let flatRounds = 0;
  for (const v of verdicts) {
    if (v === "not_comparable") continue;
    if (!FLAT_VERDICTS.has(v)) break;
    flatRounds += 1;
  }
  return { rounds: verdicts.length, flatRounds };
}

function lineageError(): unknown {
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message:
      "The two runs do not use the same eval set or a later version of it. Compare runs on one eval set.",
    retryable: false,
    suggested_tool: null,
    suggested_args: {},
    next_action: { tool: null, args: {}, ask_human: null },
  });
}

export const handleGetVerdict: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("get_verdict requires db on ToolContext");
  }
  const input = body as Input;
  const recording = input.session_id != null && input.idempotency_key != null;
  if (recording) {
    const cached = getIdempotentResponse(db, "get_verdict", input.idempotency_key!);
    if (cached) {
      return cached;
    }
  }
  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }
  const baseRun = loadProjectRun(db, input.project_id, input.baseline_run_id);
  if (!baseRun) {
    return { status: 404, body: runNotFoundError(input.baseline_run_id) };
  }
  const candRun = loadProjectRun(db, input.project_id, input.candidate_run_id);
  if (!candRun) {
    return { status: 404, body: runNotFoundError(input.candidate_run_id) };
  }
  if (!runHasCandidate(db, baseRun, input.baseline_candidate_id)) {
    return {
      status: 404,
      body: candidateNotFoundError(baseRun.id, input.baseline_candidate_id),
    };
  }
  if (!runHasCandidate(db, candRun, input.candidate_id)) {
    return { status: 404, body: candidateNotFoundError(candRun.id, input.candidate_id) };
  }
  if (lineageRootId(db, baseRun.eval_set_id) !== lineageRootId(db, candRun.eval_set_id)) {
    return { status: 400, body: lineageError() };
  }

  const objective: Objective = input.objective ?? "quality";
  const candSplit = ensureEvalSplit(db, candRun.eval_set_id);
  const baseSplit = ensureEvalSplit(db, baseRun.eval_set_id);
  const shared = [...candSplit.splits.keys()].filter((id) => baseSplit.splits.has(id));
  const isHoldout = (id: string) =>
    candSplit.splits.get(id) === "holdout" || baseSplit.splits.get(id) === "holdout";
  const trainIds = shared.filter((id) => !isHoldout(id));
  const holdoutIds = shared.filter(isHoldout);
  const directional =
    candSplit.directional ||
    baseSplit.directional ||
    trainIds.length === 0 ||
    holdoutIds.length === 0;

  const sharedSet = new Set(shared);
  const baseRows = listRunResults(db, baseRun.id).filter(
    (r) => r.model_id === input.baseline_candidate_id && sharedSet.has(r.eval_id),
  );
  const candRows = listRunResults(db, candRun.id).filter(
    (r) => r.model_id === input.candidate_id && sharedSet.has(r.eval_id),
  );
  const base = tallies(baseRows);
  const cand = tallies(candRows);
  const train = compareSplit(trainIds, base, cand);
  const holdout = compareSplit(holdoutIds, base, cand);
  const baseCost = costAndLatency(baseRows);
  const candCost = costAndLatency(candRows);

  const blocked = notComparableReason(baseRun, candRun, shared, base, cand);
  const decided = blocked
    ? { verdict: "not_comparable" as const, reason: blocked.reason }
    : decideVerdict({
        train,
        holdout,
        objective,
        baselineCostPerCall: baseCost.costPerCall,
        candidateCostPerCall: candCost.costPerCall,
      });

  const floors = [train, holdout].filter((s) => s.n_evals > 0).map((s) => s.noise_floor);
  const underpowered =
    !blocked &&
    input.min_effect != null &&
    floors.length > 0 &&
    Math.max(...floors) > input.min_effect;

  const build = (rounds: number | null, flatRounds: number | null) => {
    const plateau = flatRounds != null && flatRounds >= PLATEAU_ROUNDS;
    let nextAction: NextAction;
    if (blocked) {
      nextAction = blocked.next;
    } else if (plateau) {
      nextAction = {
        tool: null,
        args: { session_id: input.session_id, rounds, flat_rounds: flatRounds },
        ask_human: "review the optimizer branch",
      };
    } else {
      nextAction = {
        tool: null,
        args: {
          verdict: decided.verdict,
          change: decided.verdict === "keep" ? "keep" : "revert",
          candidate_run_id: candRun.id,
          candidate_id: input.candidate_id,
          ...(underpowered ? { raise_reps: true } : {}),
        },
        ask_human: null,
      };
    }
    return getVerdictOutputSchema.parse({
      verdict: decided.verdict,
      reason: decided.reason,
      objective,
      directional,
      underpowered,
      advice: underpowered
        ? "The noise is larger than min_effect. Raise reps or add trusted evals."
        : null,
      eval_set_id: candRun.eval_set_id,
      n_shared_evals: shared.length,
      train,
      holdout,
      cost_per_call_usd: {
        baseline: roundUsd(baseCost.costPerCall),
        candidate: roundUsd(candCost.costPerCall),
        delta: roundUsd(candCost.costPerCall - baseCost.costPerCall),
      },
      p50_latency_ms: {
        baseline: baseCost.p50,
        candidate: candCost.p50,
        delta: candCost.p50 - baseCost.p50,
      },
      session_id: input.session_id ?? null,
      rounds,
      flat_rounds: flatRounds,
      plateau,
      next_action: nextAction,
    });
  };

  if (!recording) {
    return { status: 200, body: build(null, null) };
  }
  const output = db.transaction(() => {
    const recorded = recordRound(db, input, objective, decided.verdict);
    const out = build(recorded.rounds, recorded.flatRounds);
    storeIdempotentResponse(db, "get_verdict", input.idempotency_key!, 200, out, input.project_id);
    return out;
  })();
  return { status: 200, body: output };
};
