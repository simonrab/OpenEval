import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export function defaultSqlitePath(): string {
  if (process.env.OPENEVAL_SQLITE) {
    return process.env.OPENEVAL_SQLITE;
  }
  const dataDir = process.env.DATA_DIR ?? "data";
  return join(dataDir, "openeval.sqlite");
}

export function openDb(sqlitePath: string): Database.Database {
  mkdirSync(dirname(sqlitePath), { recursive: true });
  const db = new Database(sqlitePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (cols.length === 0) {
    return;
  }
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/** Old run_results had one row per eval and model. Rebuild it with a rep column. */
function migrateRunResultsReps(db: Database.Database): void {
  const cols = db.pragma("table_info(run_results)") as Array<{ name: string }>;
  if (cols.length === 0 || cols.some((col) => col.name === "rep")) {
    return;
  }
  const fkOn = db.pragma("foreign_keys", { simple: true }) === 1;
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec(`ALTER TABLE run_results RENAME TO run_results_old`);
    db.exec(`
      CREATE TABLE run_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        eval_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        rep INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'scored' CHECK (outcome IN ('scored', 'error')),
        reason_short TEXT NOT NULL,
        time_ms REAL NOT NULL,
        cost_usd REAL NOT NULL,
        cost_source TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        served_model TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, eval_id, model_id, rep),
        FOREIGN KEY (run_id) REFERENCES runs(id),
        FOREIGN KEY (eval_id) REFERENCES evals(id)
      )`);
    db.exec(`
      INSERT INTO run_results
        (id, run_id, eval_id, model_id, rep, passed, outcome, reason_short,
         time_ms, cost_usd, cost_source, created_at)
      SELECT id, run_id, eval_id, model_id, 0, passed, 'scored', reason_short,
             time_ms, cost_usd, 'estimate', created_at
      FROM run_results_old`);
    db.exec(`DROP TABLE run_results_old`);
  })();
  if (fkOn) {
    db.pragma("foreign_keys = ON");
  }
}

export function migrate(db: Database.Database): void {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
  const sql = readFileSync(schemaPath, "utf8");
  db.exec(sql);
  migrateRunResultsReps(db);
  addColumnIfMissing(db, "run_results", "output_truncated", "TEXT");
  addColumnIfMissing(db, "run_results", "judge_cost_usd", "REAL");
  addColumnIfMissing(db, "evals", "mark_output", "TEXT");
  addColumnIfMissing(db, "evals", "trusted_output", "TEXT");
  addColumnIfMissing(db, "marks", "judged_output", "TEXT");
  addColumnIfMissing(db, "runs", "reps", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "runs", "candidates", "TEXT");
  addColumnIfMissing(db, "recommendations", "candidate_json", "TEXT");
  addColumnIfMissing(db, "recommendations", "backup_candidates_json", "TEXT");
  addColumnIfMissing(db, "recommendations", "cost_source", "TEXT");
  addColumnIfMissing(db, "samples", "candidate_id", "TEXT");
  addColumnIfMissing(db, "sample_groups", "candidate_id", "TEXT");
  addColumnIfMissing(db, "runtime_stats_events", "candidate_id", "TEXT");
  addColumnIfMissing(db, "live_automation", "min_pass_rate_low", "REAL");
  addColumnIfMissing(
    db,
    "live_automation",
    "require_provider_cost",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(db, "samples", "dropped_at", "TEXT");
  addColumnIfMissing(db, "project_live_state", "canary_started_at", "TEXT");
  addColumnIfMissing(db, "live_automation", "max_error_rate", "REAL");
  addColumnIfMissing(db, "live_automation", "max_quality_fail_rate", "REAL");
  addColumnIfMissing(db, "live_automation", "max_rate_increase", "REAL");
  addColumnIfMissing(db, "live_automation", "max_latency_increase", "REAL");
  addColumnIfMissing(db, "live_automation", "max_cost_increase", "REAL");
  addColumnIfMissing(db, "live_automation", "min_rollback_requests", "INTEGER");
  addColumnIfMissing(db, "live_automation", "stats_window_s", "INTEGER");
  addColumnIfMissing(db, "jobs", "registry_version", "TEXT");
  addColumnIfMissing(db, "jobs", "archetype_plan", "TEXT");
  addColumnIfMissing(db, "evals", "archetype_id", "TEXT");
  addColumnIfMissing(db, "evals", "scorer_primitive", "TEXT");
  addColumnIfMissing(db, "evals", "evidence_json", "TEXT");
  addColumnIfMissing(db, "project_live_state", "canary_policy_id", "TEXT");
  addColumnIfMissing(db, "project_live_state", "canary_percent", "INTEGER");
  addColumnIfMissing(
    db,
    "project_live_state",
    "rollback_target_policy_id",
    "TEXT",
  );
  addColumnIfMissing(
    db,
    "project_live_state",
    "hashed_request_count",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    db,
    "project_live_state",
    "canary_request_count",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    db,
    "project_live_state",
    "fallback_count",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    db,
    "project_live_state",
    "request_count",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    db,
    "project_live_state",
    "pii_blocked_count",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(db, "project_live_state", "last_known_loaded_at", "TEXT");
  addColumnIfMissing(db, "project_live_state", "stats_updated_at", "TEXT");
}
