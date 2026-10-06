import type Database from "better-sqlite3";
import { namedModelMismatchError } from "../errors.js";
import type { AgentError } from "../tools/types.js";
import type { Candidate } from "../runner/candidates.js";

export type NamedModelRef = { rec_id: string; model_id: string };

export type StoredRecommendation = {
  named_model_id: string | null;
  eval_set_id: string;
  backup_model_ids: string;
};

export function getStoredRecommendation(
  db: Database.Database,
  recId: string,
): StoredRecommendation | null {
  const row = db
    .prepare(
      `SELECT named_model_id, eval_set_id, backup_model_ids
       FROM recommendations WHERE id = ?`,
    )
    .get(recId) as StoredRecommendation | undefined;
  return row ?? null;
}

/** True when `evalSetId` is `ancestorEvalSetId` or a copy-forward descendant. */
function evalSetIsSameOrDescendantOf(
  db: Database.Database,
  evalSetId: string,
  ancestorEvalSetId: string,
): boolean {
  const seen = new Set<string>();
  const stmt = db.prepare(
    `SELECT previous_eval_set_id FROM eval_sets WHERE id = ?`,
  );
  let current: string | null = evalSetId;
  while (current) {
    if (seen.has(current)) {
      return false;
    }
    if (current === ancestorEvalSetId) {
      return true;
    }
    seen.add(current);
    const row = stmt.get(current) as
      | { previous_eval_set_id: string | null }
      | undefined;
    current = row?.previous_eval_set_id ?? null;
  }
  return false;
}

export function validateRecheckNamedModel(
  db: Database.Database,
  evalSetId: string,
  namedModel: NamedModelRef,
): AgentError | null {
  const rec = getStoredRecommendation(db, namedModel.rec_id);
  if (!rec || rec.named_model_id !== namedModel.model_id) {
    return namedModelMismatchError();
  }
  if (!evalSetIsSameOrDescendantOf(db, evalSetId, rec.eval_set_id)) {
    return namedModelMismatchError();
  }
  return null;
}

/** Recheck scores only the named model, not backups. */
export function recheckModelIds(namedModel: NamedModelRef): string[] {
  return [namedModel.model_id];
}

/** Reps of the run that named the model. A recheck uses the same reps, so the scoring is the same. */
export function getRecommendationReps(db: Database.Database, recId: string): number | null {
  const row = db
    .prepare(
      `SELECT runs.reps AS reps FROM recommendations
       JOIN runs ON runs.id = recommendations.run_id WHERE recommendations.id = ?`,
    )
    .get(recId) as { reps: number | null } | undefined;
  return row?.reps ?? null;
}

/** The candidate stored with a recommendation, when the run used candidates. */
export function getRecommendationCandidate(
  db: Database.Database,
  recId: string,
): Candidate | null {
  const row = db
    .prepare(`SELECT candidate_json FROM recommendations WHERE id = ?`)
    .get(recId) as { candidate_json: string | null } | undefined;
  return row?.candidate_json ? (JSON.parse(row.candidate_json) as Candidate) : null;
}
