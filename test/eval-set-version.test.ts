import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";

const apiKey = "test-key-not-a-secret";

function authHeaders(): { authorization: string; "content-type": string } {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

describe("eval-set version 1 schema", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-evalset-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await buildApp({ sqlitePath, apiKey });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("version 1 is a real eval_sets row; members table links evals", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "Return JSON with `line_items[]` and `total_cents`.",
        idempotency_key: "idem-version-1",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      eval_set_id: string;
      job_id: string;
      project_id: string;
      version: number;
    };
    assert.equal(body.version, 1);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((r) => r.name);
      for (const name of [
        "api_keys",
        "projects",
        "keys_refs",
        "jobs",
        "eval_sets",
        "evals",
        "eval_set_members",
        "idempotency",
      ]) {
        assert.ok(tables.includes(name), `missing table ${name}`);
      }

      const evalCols = (
        db.prepare("PRAGMA table_info(evals)").all() as { name: string }[]
      ).map((c) => c.name);
      assert.ok(!evalCols.includes("eval_set_id"));

      const setRow = db
        .prepare(
          "SELECT id, project_id, version, previous_eval_set_id, frozen_at FROM eval_sets WHERE id = ?",
        )
        .get(body.eval_set_id) as {
        id: string;
        project_id: string;
        version: number;
        previous_eval_set_id: string | null;
        frozen_at: string | null;
      };
      assert.equal(setRow.id, body.eval_set_id);
      assert.equal(setRow.project_id, body.project_id);
      assert.equal(setRow.version, 1);
      assert.equal(setRow.previous_eval_set_id, null);

      const job = db
        .prepare("SELECT id, project_id FROM jobs WHERE id = ?")
        .get(body.job_id) as { id: string; project_id: string };
      assert.equal(job.id, body.job_id);
      assert.equal(job.project_id, body.project_id);

      const memberCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM eval_set_members WHERE eval_set_id = ?",
          )
          .get(body.eval_set_id) as { n: number }
      ).n;
      assert.ok(memberCount >= 1);

      const members = db
        .prepare(
          "SELECT eval_id FROM eval_set_members WHERE eval_set_id = ?",
        )
        .all(body.eval_set_id) as { eval_id: string }[];
      for (const m of members) {
        const ev = db
          .prepare("SELECT id FROM evals WHERE id = ?")
          .get(m.eval_id) as { id: string } | undefined;
        assert.ok(ev, `eval ${m.eval_id} missing from evals`);
      }
    } finally {
      db.close();
    }
  });
});
