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

export function migrate(db: Database.Database): void {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
  const sql = readFileSync(schemaPath, "utf8");
  db.exec(sql);
}
