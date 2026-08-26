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
};

export function getRun(
  db: Database.Database,
  runId: string,
): RunRow | null {
  const row = db
    .prepare(
      `SELECT id, project_id, eval_set_id, eval_set_version, status, code,
              models, max_eval_spend_usd, keys_ref, intent, named_model,
              new_failures, spend_usd
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

export function insertRunResult(
  db: Database.Database,
  input: {
    runId: string;
    evalId: string;
    modelId: string;
    passed: boolean;
    reasonShort: string;
    timeMs: number;
    costUsd: number;
  },
): void {
  db.prepare(
    `INSERT INTO run_results
      (run_id, eval_id, model_id, passed, reason_short, time_ms, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, eval_id, model_id) DO UPDATE SET
       passed = excluded.passed,
       reason_short = excluded.reason_short,
       time_ms = excluded.time_ms,
       cost_usd = excluded.cost_usd`,
  ).run(
    input.runId,
    input.evalId,
    input.modelId,
    input.passed ? 1 : 0,
    input.reasonShort,
    input.timeMs,
    input.costUsd,
    new Date().toISOString(),
  );
}

export function listRunResults(
  db: Database.Database,
  runId: string,
): Array<{
  eval_id: string;
  model_id: string;
  passed: number;
  reason_short: string;
  time_ms: number;
  cost_usd: number;
}> {
  return db
    .prepare(
      `SELECT eval_id, model_id, passed, reason_short, time_ms, cost_usd
       FROM run_results WHERE run_id = ? ORDER BY id ASC`,
    )
    .all(runId) as Array<{
    eval_id: string;
    model_id: string;
    passed: number;
    reason_short: string;
    time_ms: number;
    cost_usd: number;
  }>;
}
