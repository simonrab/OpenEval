import type Database from "better-sqlite3";
import { namedModelMismatchError } from "../errors.js";
import type { AgentError } from "../tools/types.js";

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
