import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export function defaultSqlitePath(): string {
  if (process.env.EVALROUTER_SQLITE) {
    return process.env.EVALROUTER_SQLITE;
  }
  const dataDir = process.env.DATA_DIR ?? "data";
  return join(dataDir, "evalrouter.sqlite");
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

export function migrate(db: Database.Database): void {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
  const sql = readFileSync(schemaPath, "utf8");
  db.exec(sql);
  addColumnIfMissing(db, "samples", "dropped_at", "TEXT");
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
