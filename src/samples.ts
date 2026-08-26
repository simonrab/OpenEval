import type Database from "better-sqlite3";

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
