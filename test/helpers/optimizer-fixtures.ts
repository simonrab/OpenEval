import type Database from "better-sqlite3";
import { createEvalSetVersion1, type DraftEval } from "../../src/eval-set.js";
import { newJobId, newProjectId, newRunId } from "../../src/ids.js";
import { insertRunResult } from "../../src/runner/queue.js";

export function insertProject(db: Database.Database): string {
  const id = newProjectId();
  db.prepare(`INSERT INTO projects (id, created_at) VALUES (?, ?)`).run(
    id,
    new Date().toISOString(),
  );
  return id;
}

export function caseDraft(i: number, archetypeId: string | null = null): DraftEval {
  return {
    title: `title-${String(i).padStart(2, "0")}-x`,
    score_how: "code",
    status: "draft",
    program_check: { kind: "must_not_contain", expected: "BAD" },
    input_truncated: `input-${String(i).padStart(2, "0")}-x`,
    archetype_id: archetypeId,
  };
}

/** n trusted code evals. archetypeOf picks an archetype per index. */
export function seedTrustedSet(
  db: Database.Database,
  projectId: string,
  n: number,
  archetypeOf: (i: number) => string | null = () => null,
): { evalSetId: string; evalIds: string[] } {
  const jobId = newJobId();
  db.prepare(
    `INSERT INTO jobs (id, project_id, description, limits, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
  ).run(jobId, projectId, "Answer job", new Date().toISOString());
  const drafts = Array.from({ length: n }, (_, i) => caseDraft(i, archetypeOf(i)));
  const created = createEvalSetVersion1(db, { projectId, jobId, drafts });
  const trust = db.prepare(`UPDATE evals SET status = 'trusted' WHERE id = ?`);
  for (const ev of created.evals) {
    trust.run(ev.eval_id);
  }
  return {
    evalSetId: created.evalSetId,
    evalIds: created.evals.map((e) => e.eval_id),
  };
}

export function insertRun(
  db: Database.Database,
  opts: {
    projectId: string;
    evalSetId: string;
    candidateIds: string[];
    status?: string;
  },
): string {
  const id = newRunId();
  const now = new Date().toISOString();
  const version = (
    db.prepare(`SELECT version FROM eval_sets WHERE id = ?`).get(opts.evalSetId) as {
      version: number;
    }
  ).version;
  db.prepare(
    `INSERT INTO runs
      (id, project_id, eval_set_id, eval_set_version, status, code, models,
       max_eval_spend_usd, keys_ref, intent, named_model, new_failures,
       spend_usd, idempotency_key, created_at, updated_at, reps, candidates)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 10, NULL, NULL, NULL, NULL, 0, NULL, ?, ?, 3, NULL)`,
  ).run(
    id,
    opts.projectId,
    opts.evalSetId,
    version,
    opts.status ?? "succeeded",
    JSON.stringify(opts.candidateIds),
    now,
    now,
  );
  return id;
}

/** One row per rep. true = pass, false = fail, "error" = call failed. */
export function addResults(
  db: Database.Database,
  runId: string,
  candidateId: string,
  evalId: string,
  reps: Array<boolean | "error">,
  opts: { costUsd?: number; timeMs?: number; output?: string } = {},
): void {
  reps.forEach((rep, i) => {
    insertRunResult(db, {
      runId,
      evalId,
      modelId: candidateId,
      rep: i,
      passed: rep === true,
      outcome: rep === "error" ? "error" : "scored",
      reasonShort: rep === true ? "ok" : rep === "error" ? "model call failed" : "wrong answer",
      timeMs: rep === "error" ? 0 : (opts.timeMs ?? 100),
      costUsd: rep === "error" ? 0 : (opts.costUsd ?? 0.01),
      costSource: "provider",
      output: rep === "error" ? null : (opts.output ?? `output for ${evalId}`),
    });
  });
}
