import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";

const apiKey = "test-key-not-a-secret";

const DEMO_DESCRIPTION = "Return JSON with `line_items[]` and `total_cents`.";

function authHeaders(): { authorization: string; "content-type": string } {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

function acceptToken(evalSetId: string): string {
  return createHmac("sha256", apiKey).update(`accept:${evalSetId}`).digest("hex");
}

type GenerateSuccess = {
  project_id: string;
  eval_set_id: string;
  version: number;
  evals: Array<{
    eval_id: string;
    title: string;
    score_how: "code" | "person";
    status: string;
  }>;
  n_code: number;
  n_person: number;
};

type MemberRow = { eval_id: string; score_how: string; status: string };

function members(
  sqlitePath: string,
  evalSetId: string,
): MemberRow[] {
  const db = new Database(sqlitePath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT e.id AS eval_id, e.score_how, e.status
       FROM eval_set_members m
       JOIN evals e ON e.id = m.eval_id
       WHERE m.eval_set_id = ?
       ORDER BY e.id`,
    )
    .all(evalSetId) as MemberRow[];
  db.close();
  return rows;
}

function runResultCount(sqlitePath: string): number {
  const db = new Database(sqlitePath, { readonly: true });
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM run_results")
    .get() as { n: number };
  db.close();
  return row.n;
}

describe("accept screen (J1)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-accept-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await buildApp({ sqlitePath, apiKey });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function generateDemo(): Promise<GenerateSuccess> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: DEMO_DESCRIPTION,
        idempotency_key: "idem-accept-demo",
      },
    });
    assert.equal(res.statusCode, 200);
    return res.json() as GenerateSuccess;
  }

  it("GET HTML shows draft evals and does not call them tests", async () => {
    const gen = await generateDemo();
    const token = acceptToken(gen.eval_set_id);
    const res = await app.inject({
      method: "GET",
      url: `/accept?eval_set_id=${encodeURIComponent(gen.eval_set_id)}&token=${token}`,
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    const html = res.body;
    assert.match(html, /draft/i);
    assert.match(html, /eval/i);
    assert.doesNotMatch(html, /unit test/i);
    for (const ev of gen.evals) {
      assert.ok(html.includes(ev.title), `missing title ${ev.title}`);
    }
  });

  it("GET without a valid token is rejected", async () => {
    const gen = await generateDemo();
    const res = await app.inject({
      method: "GET",
      url: `/accept?eval_set_id=${encodeURIComponent(gen.eval_set_id)}&token=nope`,
    });
    assert.ok(res.statusCode === 401 || res.statusCode === 403);
  });

  it("accept code evals and reject others: kept are trusted, rejected are gone, no model run", async () => {
    const mixed = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "a helpful assistant",
        what_good_means: {
          how_it_should_behave: "sound like a good reply with a warm tone",
          success: "the output is valid JSON",
          must_never: "swear at the user",
        },
        idempotency_key: "idem-mixed-accept",
      },
    });
    assert.equal(mixed.statusCode, 200);
    const gen = mixed.json() as GenerateSuccess;

    const db = new Database(sqlitePath, { readonly: true });
    const allEvals = db
      .prepare(
        `SELECT e.id AS eval_id, e.score_how, e.status
         FROM eval_set_members m
         JOIN evals e ON e.id = m.eval_id
         WHERE m.eval_set_id = ?`,
      )
      .all(gen.eval_set_id) as MemberRow[];
    db.close();
    assert.ok(allEvals.length >= 1);

    const acceptIds = allEvals
      .filter((e) => e.score_how === "code")
      .map((e) => e.eval_id);
    const rejectIds = allEvals
      .filter((e) => e.score_how !== "code")
      .map((e) => e.eval_id);
    assert.ok(acceptIds.length >= 1);

    const token = acceptToken(gen.eval_set_id);
    const res = await app.inject({
      method: "POST",
      url: "/accept",
      headers: { "content-type": "application/json" },
      payload: {
        eval_set_id: gen.eval_set_id,
        token,
        accept: acceptIds,
        reject: rejectIds,
      },
    });
    assert.ok(res.statusCode === 200 || res.statusCode === 303);
    const body = res.json() as {
      next_action?: { tool?: string | null };
    };
    if (rejectIds.length === 0 || acceptIds.length === allEvals.length) {
      assert.equal(body.next_action?.tool, "run_evals");
    }

    const after = members(sqlitePath, gen.eval_set_id);
    const afterIds = after.map((e) => e.eval_id);
    for (const id of acceptIds) {
      assert.ok(afterIds.includes(id));
      const row = after.find((e) => e.eval_id === id);
      assert.equal(row?.status, "trusted");
      assert.notEqual(row?.status, "draft");
    }
    for (const id of rejectIds) {
      assert.ok(!afterIds.includes(id));
    }

    assert.equal(runResultCount(sqlitePath), 0);
  });

  it("demo: accept all code evals then next_action is run_evals", async () => {
    const gen = await generateDemo();
    const db = new Database(sqlitePath, { readonly: true });
    const allEvals = db
      .prepare(
        `SELECT e.id AS eval_id, e.score_how
         FROM eval_set_members m
         JOIN evals e ON e.id = m.eval_id
         WHERE m.eval_set_id = ?`,
      )
      .all(gen.eval_set_id) as { eval_id: string; score_how: string }[];
    db.close();
    const codeIds = allEvals
      .filter((e) => e.score_how === "code")
      .map((e) => e.eval_id);
    const otherIds = allEvals
      .filter((e) => e.score_how !== "code")
      .map((e) => e.eval_id);

    const res = await app.inject({
      method: "POST",
      url: "/accept",
      headers: { "content-type": "application/json" },
      payload: {
        eval_set_id: gen.eval_set_id,
        token: acceptToken(gen.eval_set_id),
        accept: codeIds,
        reject: otherIds,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      eval_set_id?: string;
      version?: number;
      next_action?: { tool?: string | null };
    };
    assert.equal(body.eval_set_id, gen.eval_set_id);
    assert.equal(body.version, 1);
    assert.equal(body.next_action?.tool, "run_evals");

    const after = members(sqlitePath, gen.eval_set_id);
    assert.ok(after.length >= 1);
    for (const row of after) {
      assert.equal(row.status, "trusted");
      assert.equal(row.score_how, "code");
    }
    assert.equal(runResultCount(sqlitePath), 0);
  });
});
