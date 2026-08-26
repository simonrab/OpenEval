import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { newSampleGroupId } from "./ids.js";

export type SampleRow = {
  id: string;
  project_id: string;
  policy_id: string;
  model_id: string;
  why: string;
  input_redacted: string;
  output_redacted: string;
  captured_at: string;
  dropped_at: string | null;
};

export type SampleGroupRow = {
  id: string;
  project_id: string;
  policy_id: string;
  model_id: string;
  why: string;
  fingerprint: string;
  state: string;
  sample_count: number;
  exemplar_sample_id: string;
  created_at: string;
  updated_at: string;
};

function sampleFingerprint(row: {
  project_id: string;
  policy_id: string;
  model_id: string;
  why: string;
  input_redacted: string;
  output_redacted: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        project_id: row.project_id,
        policy_id: row.policy_id,
        model_id: row.model_id,
        why: row.why,
        input_redacted: row.input_redacted,
        output_redacted: row.output_redacted,
      }),
      "utf8",
    )
    .digest("hex");
}

export function getSample(
  db: Database.Database,
  sampleId: string,
): SampleRow | null {
  const row = db
    .prepare(
      `SELECT id, project_id, policy_id, model_id, why,
              input_redacted, output_redacted, captured_at, dropped_at
       FROM samples
       WHERE id = ?`,
    )
    .get(sampleId) as SampleRow | undefined;
  return row ?? null;
}

export function dropSample(db: Database.Database, sampleId: string): boolean {
  const result = db
    .prepare(
      `UPDATE samples
       SET dropped_at = ?
       WHERE id = ? AND dropped_at IS NULL`,
    )
    .run(new Date().toISOString(), sampleId);
  return result.changes > 0;
}

export function countProjectSamples(
  db: Database.Database,
  projectId: string,
): { stored: number; dropped: number } {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN dropped_at IS NULL THEN 1 ELSE 0 END) AS stored,
         SUM(CASE WHEN dropped_at IS NOT NULL THEN 1 ELSE 0 END) AS dropped
       FROM samples
       WHERE project_id = ?`,
    )
    .get(projectId) as { stored: number | null; dropped: number | null };
  return {
    stored: row.stored ?? 0,
    dropped: row.dropped ?? 0,
  };
}

export function listStoredSamples(
  db: Database.Database,
  projectId: string,
  offset: number,
  limit: number,
): SampleRow[] {
  return db
    .prepare(
      `SELECT id, project_id, policy_id, model_id, why,
              input_redacted, output_redacted, captured_at, dropped_at
       FROM samples
       WHERE project_id = ? AND dropped_at IS NULL
       ORDER BY captured_at ASC, id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(projectId, limit, offset) as SampleRow[];
}

export function isPromotableSample(
  row: SampleRow | null,
  projectId: string,
): row is SampleRow {
  return (
    row != null && row.project_id === projectId && row.dropped_at == null
  );
}

export function upsertSampleGroup(
  db: Database.Database,
  row: {
    id: string;
    project_id: string;
    policy_id: string;
    model_id: string;
    why: string;
    input_redacted: string;
    output_redacted: string;
  },
): string {
  const fingerprint = sampleFingerprint(row);
  const now = new Date().toISOString();
  const existing = db
    .prepare(
      `SELECT id, state
       FROM sample_groups
       WHERE project_id = ? AND fingerprint = ?`,
    )
    .get(row.project_id, fingerprint) as { id: string; state: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE sample_groups
       SET sample_count = sample_count + 1,
           updated_at = ?
       WHERE id = ?`,
    ).run(now, existing.id);
    return existing.id;
  }
  const groupId = newSampleGroupId();
  db.prepare(
    `INSERT INTO sample_groups (
       id, project_id, policy_id, model_id, why, fingerprint, state,
       sample_count, exemplar_sample_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'new', 1, ?, ?, ?)`,
  ).run(
    groupId,
    row.project_id,
    row.policy_id,
    row.model_id,
    row.why,
    fingerprint,
    row.id,
    now,
    now,
  );
  return groupId;
}

export function listSampleGroups(
  db: Database.Database,
  projectId: string,
): SampleGroupRow[] {
  return db
    .prepare(
      `SELECT id, project_id, policy_id, model_id, why, fingerprint, state,
              sample_count, exemplar_sample_id, created_at, updated_at
       FROM sample_groups
       WHERE project_id = ?
       ORDER BY updated_at ASC, id ASC`,
    )
    .all(projectId) as SampleGroupRow[];
}

export function quarantineFloodedSampleGroups(
  db: Database.Database,
  projectId: string,
  sampleFloodLimit: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT id
       FROM sample_groups
       WHERE project_id = ?
         AND state != 'quarantined'
         AND sample_count > ?`,
    )
    .all(projectId, sampleFloodLimit) as Array<{ id: string }>;
  if (rows.length === 0) {
    return [];
  }
  const now = new Date().toISOString();
  const update = db.prepare(
    `UPDATE sample_groups
     SET state = 'quarantined',
         updated_at = ?
     WHERE id = ?`,
  );
  for (const row of rows) {
    update.run(now, row.id);
  }
  return rows.map((row) => row.id);
}

export function markSampleGroupState(
  db: Database.Database,
  groupId: string,
  state: "new" | "candidate" | "promoted" | "blocked" | "quarantined",
): boolean {
  const result = db
    .prepare(
      `UPDATE sample_groups
       SET state = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(state, new Date().toISOString(), groupId);
  return result.changes > 0;
}
