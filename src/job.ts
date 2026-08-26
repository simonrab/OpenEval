import type Database from "better-sqlite3";
import type { JobLimits } from "./rank.js";

export function getJobLimits(
  db: Database.Database,
  evalSetId: string,
): JobLimits | null {
  const row = db
    .prepare(
      `SELECT j.limits FROM eval_sets es
       JOIN jobs j ON j.id = es.job_id
       WHERE es.id = ?`,
    )
    .get(evalSetId) as { limits: string | null } | undefined;
  if (!row?.limits) {
    return null;
  }
  return JSON.parse(row.limits) as JobLimits;
}

export function getJobSystemPrompt(
  db: Database.Database,
  evalSetId: string,
): string | null {
  const limits = getJobLimits(db, evalSetId);
  const prompt = limits?.system_prompt;
  if (typeof prompt !== "string") {
    return null;
  }
  const text = prompt.trim();
  return text.length > 0 ? text : null;
}
