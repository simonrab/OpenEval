import type Database from "better-sqlite3";
import { listMembers } from "./eval-set.js";
import { newEvalSetId } from "./ids.js";

export type CopyEvalSetResult = {
  newEvalSetId: string;
  previousEvalSetId: string;
  version: number;
  oldEvalIds: string[];
};

export function getLatestEvalSetForProject(
  db: Database.Database,
  projectId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM eval_sets
       WHERE project_id = ?
       ORDER BY version DESC, created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(projectId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function copyEvalSetForward(
  db: Database.Database,
  opts: {
    projectId: string;
    sourceEvalSetId: string;
    omitEvalIds?: string[];
  },
): CopyEvalSetResult {
  const source = db
    .prepare(
      `SELECT id, project_id, job_id, version FROM eval_sets WHERE id = ?`,
    )
    .get(opts.sourceEvalSetId) as
    | { id: string; project_id: string; job_id: string | null; version: number }
    | undefined;

  if (!source || source.project_id !== opts.projectId) {
    throw new Error("eval set not found for project");
  }

  const memberRows = db
    .prepare(
      `SELECT m.eval_id FROM eval_set_members m
       JOIN evals e ON e.id = m.eval_id
       WHERE m.eval_set_id = ?
       ORDER BY e.created_at ASC, e.id ASC`,
    )
    .all(opts.sourceEvalSetId) as Array<{ eval_id: string }>;
  const omit = new Set(opts.omitEvalIds ?? []);
  const oldEvalIds = memberRows
    .map((r) => r.eval_id)
    .filter((id) => !omit.has(id));

  const nextEvalSetId = newEvalSetId();
  const createdAt = new Date().toISOString();
  const newVersion = source.version + 1;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO eval_sets
        (id, project_id, job_id, version, previous_eval_set_id, frozen_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      nextEvalSetId,
      opts.projectId,
      source.job_id,
      newVersion,
      opts.sourceEvalSetId,
      createdAt,
    );

    const insertMember = db.prepare(
      `INSERT INTO eval_set_members (eval_set_id, eval_id) VALUES (?, ?)`,
    );
    for (const evalId of oldEvalIds) {
      insertMember.run(nextEvalSetId, evalId);
    }

    if (oldEvalIds.length > 0) {
      const placeholders = oldEvalIds.map(() => "?").join(", ");
      db.prepare(
        `INSERT INTO marks (eval_set_id, eval_id, person_id, mark_json, is_third, created_at)
         SELECT ?, eval_id, person_id, mark_json, is_third, created_at
         FROM marks
         WHERE eval_set_id = ?
           AND eval_id IN (${placeholders})`,
      ).run(nextEvalSetId, opts.sourceEvalSetId, ...oldEvalIds);
    }
  });
  tx();

  return {
    newEvalSetId: nextEvalSetId,
    previousEvalSetId: opts.sourceEvalSetId,
    version: newVersion,
    oldEvalIds,
  };
}

export function getOldTrustedEvalIds(
  db: Database.Database,
  evalSetId: string,
): string[] {
  const row = db
    .prepare(`SELECT previous_eval_set_id FROM eval_sets WHERE id = ?`)
    .get(evalSetId) as { previous_eval_set_id: string | null } | undefined;
  if (!row?.previous_eval_set_id) {
    return [];
  }

  const currentIds = new Set(
    (
      db
        .prepare(
          `SELECT eval_id FROM eval_set_members WHERE eval_set_id = ?`,
        )
        .all(evalSetId) as Array<{ eval_id: string }>
    ).map((m) => m.eval_id),
  );

  return listMembers(db, row.previous_eval_set_id)
    .filter((m) => m.status === "trusted" && currentIds.has(m.eval_id))
    .map((m) => m.eval_id);
}
