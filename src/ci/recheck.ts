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

export function validateRecheckNamedModel(
  db: Database.Database,
  evalSetId: string,
  namedModel: NamedModelRef,
): AgentError | null {
  const rec = getStoredRecommendation(db, namedModel.rec_id);
  if (
    !rec ||
    rec.eval_set_id !== evalSetId ||
    rec.named_model_id !== namedModel.model_id
  ) {
    return namedModelMismatchError();
  }
  return null;
}

/** Recheck scores only the named model, not backups. */
export function recheckModelIds(namedModel: NamedModelRef): string[] {
  return [namedModel.model_id];
}
