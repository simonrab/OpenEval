import type Database from "better-sqlite3";

export type RunRow = {
  id: string;
  project_id: string;
  eval_set_id: string;
  eval_set_version: number;
  status: string;
  code: string | null;
  models: string;
  max_eval_spend_usd: number;
  keys_ref: string | null;
  intent: string | null;
  named_model: string | null;
  new_failures: string | null;
  spend_usd: number;
  reps: number;
  candidates: string | null;
};

/** Runs made by submit_outputs. The worker never claims them. */
export const OPTIMIZE_INTENT = "optimize";

export function getRun(
  db: Database.Database,
  runId: string,
): RunRow | null {
  const row = db
    .prepare(
      `SELECT id, project_id, eval_set_id, eval_set_version, status, code,
              models, max_eval_spend_usd, keys_ref, intent, named_model,
              new_failures, spend_usd, reps, candidates
       FROM runs WHERE id = ?`,
    )
    .get(runId) as RunRow | undefined;
  return row ?? null;
}

export function claimNextRun(db: Database.Database): string | null {
  const row = db
    .prepare(
      `SELECT id FROM runs WHERE status = 'queued'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (!row) {
    return null;
  }
  const updated = db
    .prepare(
      `UPDATE runs SET status = 'running', updated_at = ?
       WHERE id = ? AND status = 'queued'`,
    )
    .run(new Date().toISOString(), row.id);
  if (updated.changes === 0) {
    return null;
  }
  return row.id;
}

export function updateRunStatus(
  db: Database.Database,
  runId: string,
  status: string,
  code: string | null,
  spendUsd: number,
): void {
  db.prepare(
    `UPDATE runs SET status = ?, code = ?, spend_usd = ?, updated_at = ? WHERE id = ?`,
  ).run(status, code, spendUsd, new Date().toISOString(), runId);
}

export type RunResultInput = {
  runId: string;
  evalId: string;
  modelId: string;
  rep?: number;
  passed: boolean;
  /** error = the model call failed after retries. It is not a quality fail. */
  outcome?: "scored" | "error";
  reasonShort: string;
  timeMs: number;
  costUsd: number;
  costSource?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  servedModel?: string | null;
  attempts?: number;
  /** Model output. It is cut to OUTPUT_TRUNCATE chars. Reports never show it. */
  output?: string | null;
  /** Cost of the judge call that graded this output. Not part of costUsd. */
  judgeCostUsd?: number | null;
};

export const OUTPUT_TRUNCATE = 4000;

export function insertRunResult(
  db: Database.Database,
  input: RunResultInput,
): void {
  db.prepare(
    `INSERT INTO run_results
      (run_id, eval_id, model_id, rep, passed, outcome, reason_short, time_ms,
       cost_usd, cost_source, prompt_tokens, completion_tokens, served_model,
       attempts, output_truncated, judge_cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, eval_id, model_id, rep) DO UPDATE SET
       passed = excluded.passed,
       outcome = excluded.outcome,
       reason_short = excluded.reason_short,
       time_ms = excluded.time_ms,
       cost_usd = excluded.cost_usd,
       cost_source = excluded.cost_source,
       prompt_tokens = excluded.prompt_tokens,
       completion_tokens = excluded.completion_tokens,
       served_model = excluded.served_model,
       attempts = excluded.attempts,
       output_truncated = excluded.output_truncated,
       judge_cost_usd = excluded.judge_cost_usd`,
  ).run(
    input.runId,
    input.evalId,
    input.modelId,
    input.rep ?? 0,
    input.passed ? 1 : 0,
    input.outcome ?? "scored",
    input.reasonShort,
    input.timeMs,
    input.costUsd,
    input.costSource ?? null,
    input.promptTokens ?? null,
    input.completionTokens ?? null,
    input.servedModel ?? null,
    input.attempts ?? 1,
    input.output == null ? null : input.output.slice(0, OUTPUT_TRUNCATE),
    input.judgeCostUsd ?? null,
    new Date().toISOString(),
  );
}

export type RunResultRow = {
  eval_id: string;
  model_id: string;
  rep: number;
  passed: number;
  outcome: "scored" | "error";
  reason_short: string;
  time_ms: number;
  cost_usd: number;
  cost_source: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  served_model: string | null;
  attempts: number;
};

export function listRunResults(
  db: Database.Database,
  runId: string,
): RunResultRow[] {
  return db
    .prepare(
      `SELECT eval_id, model_id, rep, passed, outcome, reason_short, time_ms,
              cost_usd, cost_source, prompt_tokens, completion_tokens,
              served_model, attempts
       FROM run_results WHERE run_id = ? ORDER BY id ASC`,
    )
    .all(runId) as RunResultRow[];
}

export type RunOutputRow = {
  eval_id: string;
  rep: number;
  passed: number;
  outcome: "scored" | "error";
  reason_short: string;
  output_truncated: string | null;
};

/** Rows with outputs for one candidate. Only get_training_failures reads this. */
export function listCandidateOutputs(
  db: Database.Database,
  runId: string,
  candidateId: string,
): RunOutputRow[] {
  return db
    .prepare(
      `SELECT eval_id, rep, passed, outcome, reason_short, output_truncated
       FROM run_results WHERE run_id = ? AND model_id = ? ORDER BY rep ASC, id ASC`,
    )
    .all(runId, candidateId) as RunOutputRow[];
}
