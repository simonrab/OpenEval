import { newIdempotencyKey, type OpenEvalClient, type VerdictResult } from "./client.js";
import { budgetSpent, roundsDone, saveState, type RunRef, type TuneState } from "./state.js";

/** Exit codes of the verdict command. */
export const EXIT = {
  ok: 0,
  error: 1,
  revert: 2,
  within_noise: 3,
  not_comparable: 4,
  plateau: 5,
  limit: 6,
  waiting_for_person: 7,
} as const;

export type Stop = "plateau" | "budget" | "max_rounds" | null;

export function verdictExitCode(verdict: VerdictResult["verdict"], stop: Stop): number {
  if (stop === "plateau") return EXIT.plateau;
  if (stop === "budget" || stop === "max_rounds") return EXIT.limit;
  switch (verdict) {
    case "keep":
      return EXIT.ok;
    case "revert_overfit":
    case "revert_regressed":
      return EXIT.revert;
    case "within_noise":
      return EXIT.within_noise;
    case "not_comparable":
      return EXIT.not_comparable;
  }
}

/** What the agent does with the commit of this round. */
export function actionFor(verdict: VerdictResult["verdict"]): "keep" | "revert" | "fix_and_rescore" {
  if (verdict === "keep") return "keep";
  if (verdict === "not_comparable") return "fix_and_rescore";
  return "revert";
}

export type VerdictOptions = {
  candidate: RunRef;
  baseline?: RunRef;
  objective?: "quality" | "cost";
  minEffect?: number | null;
};

export type VerdictOutcome = {
  result: VerdictResult;
  action: "keep" | "revert" | "fix_and_rescore";
  stop: Stop;
  exitCode: number;
  baseline: RunRef;
};

/** Ask OpenEval for a verdict in this session, then update the state. */
export async function runVerdict(
  client: OpenEvalClient,
  state: TuneState,
  stateDir: string,
  opts: VerdictOptions,
): Promise<VerdictOutcome> {
  const baseline = opts.baseline ?? state.baseline;
  if (!baseline) {
    throw new Error('There is no baseline. Run "openeval-tune baseline" first.');
  }
  const minEffect = opts.minEffect === undefined ? state.min_effect : opts.minEffect;
  const body: Record<string, unknown> = {
    project_id: state.project_id,
    baseline_run_id: baseline.run_id,
    baseline_candidate_id: baseline.candidate_id,
    candidate_run_id: opts.candidate.run_id,
    candidate_id: opts.candidate.candidate_id,
    objective: opts.objective ?? state.objective,
    session_id: state.session_id,
    idempotency_key: newIdempotencyKey(),
  };
  if (minEffect != null) body.min_effect = minEffect;
  const result = await client.tool<VerdictResult>("get_verdict", body);

  state.rounds.push({
    round: state.rounds.length + 1,
    run_id: opts.candidate.run_id,
    candidate_id: opts.candidate.candidate_id,
    verdict: result.verdict,
    reason: result.reason,
    train_delta: result.train.delta,
    holdout_delta: result.holdout.delta,
    underpowered: result.underpowered,
    plateau: result.plateau,
    created_at: new Date().toISOString(),
  });
  if (result.verdict === "keep") {
    state.baseline = { ...opts.candidate };
  }
  saveState(stateDir, state);

  let stop: Stop = null;
  if (result.plateau) stop = "plateau";
  else if (budgetSpent(state)) stop = "budget";
  else if (roundsDone(state)) stop = "max_rounds";
  return {
    result,
    action: actionFor(result.verdict),
    stop,
    exitCode: verdictExitCode(result.verdict, stop),
    baseline,
  };
}
