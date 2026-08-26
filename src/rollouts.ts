import type Database from "better-sqlite3";
import { newRolloutId } from "./ids.js";

export type RolloutIntent = "canary" | "full" | "rollback";
export type RolloutStatus = "pending" | "approved" | "rejected";

export type LiveRollout = {
  id: string;
  project_id: string;
  intent: RolloutIntent;
  old_policy_id: string | null;
  new_policy_id: string | null;
  rollback_target_policy_id: string | null;
  status: RolloutStatus;
  created_at: string;
  decided_at: string | null;
};

export function insertLiveRollout(
  db: Database.Database,
  args: {
    project_id: string;
    intent: RolloutIntent;
    old_policy_id: string | null;
    new_policy_id: string | null;
    rollback_target_policy_id: string | null;
  },
): LiveRollout {
  const id = newRolloutId();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO live_rollouts (
       id, project_id, intent, old_policy_id, new_policy_id,
       rollback_target_policy_id, status, created_at, decided_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
  ).run(
    id,
    args.project_id,
    args.intent,
    args.old_policy_id,
    args.new_policy_id,
    args.rollback_target_policy_id,
    createdAt,
  );
  return {
    id,
    project_id: args.project_id,
    intent: args.intent,
    old_policy_id: args.old_policy_id,
    new_policy_id: args.new_policy_id,
    rollback_target_policy_id: args.rollback_target_policy_id,
    status: "pending",
    created_at: createdAt,
    decided_at: null,
  };
}

export function getLiveRollout(
  db: Database.Database,
  rolloutId: string,
): LiveRollout | null {
  const row = db
    .prepare(
      `SELECT id, project_id, intent, old_policy_id, new_policy_id,
              rollback_target_policy_id, status, created_at, decided_at
       FROM live_rollouts
       WHERE id = ?`,
    )
    .get(rolloutId) as LiveRollout | undefined;
  return row ?? null;
}

export function markRolloutDecision(
  db: Database.Database,
  rolloutId: string,
  status: "approved" | "rejected",
): void {
  db.prepare(
    `UPDATE live_rollouts
     SET status = ?, decided_at = ?
     WHERE id = ?`,
  ).run(status, new Date().toISOString(), rolloutId);
}
