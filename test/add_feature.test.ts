import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { listMembers } from "../src/eval-set.js";
import { generateEvalSuiteOutputSchema } from "../src/tools/schema.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";
import {
  authHeaders,
  createTestApp,
  seedFiveTrustedEvals,
  storeCustomerKey,
} from "./helpers/run-fixtures.js";

type GenerateSuccess = {
  project_id: string;
  job_id: string;
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
  n_draft: number;
  counts: {
    draft: number;
    code: number;
    needs_person: number;
    trusted: number;
    total: number;
  };
  mark_url: string | null;
  next_action: {
    tool: string | null;
    args: Record<string, unknown>;
    ask_human: string | null;
  };
};

async function postGenerate(
  app: FastifyInstance,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/v1/tools/generate_eval_suite",
    headers: authHeaders(),
    payload,
  });
}

describe("add_feature (J6)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let oldEvalIds: string[];
  let keysRef: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-add-feature-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await createTestApp(sqlitePath);

    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeaders(),
      payload: {},
    });
    projectId = (proj.json() as { project_id: string }).project_id;

    const db = new Database(sqlitePath);
    try {
      const seeded = seedFiveTrustedEvals(db, projectId);
      evalSetId = seeded.evalSetId;
      oldEvalIds = seeded.evalIds;
      keysRef = await storeCustomerKey(db, projectId);
    } finally {
      db.close();
    }
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("add_feature copy-forwards old evals and adds new drafts", async () => {
    const newDescription =
      "Return JSON with `line_items[]`, `total_cents`, and `currency`.";
    const res = await postGenerate(app, {
      project_id: projectId,
      eval_set_id: evalSetId,
      intent: "add_feature",
      description: newDescription,
      idempotency_key: "add-v2-1",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as GenerateSuccess;
    assert.equal(generateEvalSuiteOutputSchema.safeParse(body).success, true);

    assert.notEqual(body.eval_set_id, evalSetId);
    assert.equal(body.version, 2);
    assert.equal(body.project_id, projectId);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const v1Count = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM eval_set_members WHERE eval_set_id = ?",
          )
          .get(evalSetId) as { n: number }
      ).n;
      assert.equal(v1Count, oldEvalIds.length);

      const v1Version = (
        db
          .prepare("SELECT version FROM eval_sets WHERE id = ?")
          .get(evalSetId) as { version: number }
      ).version;
      assert.equal(v1Version, 1);

      const v2Members = listMembers(db, body.eval_set_id);
      const v2Ids = v2Members.map((m) => m.eval_id);
      for (const id of oldEvalIds) {
        assert.ok(v2Ids.includes(id), `old eval ${id} missing from v2`);
      }
      assert.ok(v2Members.length > oldEvalIds.length);

      const newDrafts = v2Members.filter((m) => m.status === "draft");
      assert.ok(newDrafts.length >= 1);
      assert.equal(body.counts.trusted, oldEvalIds.length);
      assert.ok(body.n_draft >= newDrafts.length);
    } finally {
      db.close();
    }
  });

  it("add_feature twice yields version 3 with old evals plus new drafts", async () => {
    const first = await postGenerate(app, {
      project_id: projectId,
      eval_set_id: evalSetId,
      intent: "add_feature",
      description: "Return JSON with `line_items[]`, `total_cents`, and `currency`.",
      idempotency_key: "add-v2-demo",
    });
    assert.equal(first.statusCode, 200);
    const v2 = (first.json() as GenerateSuccess).eval_set_id;

    const second = await postGenerate(app, {
      project_id: projectId,
      eval_set_id: v2,
      intent: "add_feature",
      description:
        "Return JSON with `line_items[]`, `total_cents`, `currency`, and `due_date`.",
      idempotency_key: "add-v3-demo",
    });
    assert.equal(second.statusCode, 200);
    const body = second.json() as GenerateSuccess;
    assert.equal(body.version, 3);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const setCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM eval_sets WHERE project_id = ?",
          )
          .get(projectId) as { n: number }
      ).n;
      assert.equal(setCount, 3);

      const v3Members = listMembers(db, body.eval_set_id);
      const v3Ids = v3Members.map((m) => m.eval_id);
      for (const id of oldEvalIds) {
        assert.ok(v3Ids.includes(id), `old eval ${id} missing from v3`);
      }
      assert.ok(v3Members.some((m) => m.status === "draft"));
      assert.ok(v3Members.filter((m) => m.status === "trusted").length >= oldEvalIds.length);
    } finally {
      db.close();
    }
  });

  it("same idempotency_key returns the same new ste_", async () => {
    const payload = {
      project_id: projectId,
      eval_set_id: evalSetId,
      intent: "add_feature" as const,
      description: "Return JSON with `line_items[]`, `total_cents`, and `currency`.",
      idempotency_key: "add-idem-1",
    };
    const a = await postGenerate(app, payload);
    const b = await postGenerate(app, payload);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(
      (a.json() as GenerateSuccess).eval_set_id,
      (b.json() as GenerateSuccess).eval_set_id,
    );

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const setCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM eval_sets WHERE project_id = ?",
          )
          .get(projectId) as { n: number }
      ).n;
      assert.equal(setCount, 2);
    } finally {
      db.close();
    }
  });

  it("returns SUITE_NOT_FOUND for unknown eval_set_id", async () => {
    const res = await postGenerate(app, {
      project_id: projectId,
      eval_set_id: "ste_missing",
      intent: "add_feature",
      description: "Return JSON with `line_items[]` and `total_cents`.",
      idempotency_key: "add-missing-ste",
    });
    assert.equal(res.statusCode, 404);
    assert.equal(isAgentError(res.json()), true);
    assert.equal((res.json() as { code: string }).code, ErrorCode.SUITE_NOT_FOUND);
  });

  function seedFinishedRun(
    evalSet: string,
    runId: string,
    rows: Array<{
      modelId: string;
      evalId: string;
      passed: boolean;
      timeMs: number;
      costUsd: number;
    }>,
  ): void {
    const db = new Database(sqlitePath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs
        (id, project_id, eval_set_id, eval_set_version, status, code, models,
         max_eval_spend_usd, keys_ref, intent, named_model, new_failures,
         spend_usd, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 2, 'succeeded', NULL, ?, 5, ?, 'add_feature', NULL, NULL, 0.5, ?, ?, ?)`,
    ).run(
      runId,
      projectId,
      evalSet,
      JSON.stringify([...new Set(rows.map((r) => r.modelId))]),
      keysRef,
      `seed-${runId}`,
      now,
      now,
    );
    const insert = db.prepare(
      `INSERT INTO run_results
        (run_id, eval_id, model_id, passed, reason_short, time_ms, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        runId,
        row.evalId,
        row.modelId,
        row.passed ? 1 : 0,
        row.passed ? "ok" : "fail",
        row.timeMs,
        row.costUsd,
        now,
      );
    }
    db.close();
  }

  it("recommend_models add_feature does not name a model failing an old eval", async () => {
    const added = await postGenerate(app, {
      project_id: projectId,
      eval_set_id: evalSetId,
      intent: "add_feature",
      description: "Return JSON with `line_items[]`, `total_cents`, and `currency`.",
      idempotency_key: "add-for-rec",
    });
    assert.equal(added.statusCode, 200);
    const newSte = (added.json() as GenerateSuccess).eval_set_id;

    const db = new Database(sqlitePath, { readonly: true });
    let totalCentsEvalId: string;
    try {
      const members = listMembers(db, newSte);
      const hit = members.find((m) => m.title === "JSON has total_cents");
      assert.ok(hit);
      totalCentsEvalId = hit.eval_id;
    } finally {
      db.close();
    }

    const runId = "run_add_feature_old_fail";
    const rows = oldEvalIds.flatMap((evalId) => {
      const passOld = evalId !== totalCentsEvalId;
      return [
        {
          modelId: "openai/gpt-4o-mini",
          evalId,
          passed: passOld,
          timeMs: 100,
          costUsd: 0.01,
        },
        {
          modelId: "google/gemini-flash-1.5",
          evalId,
          passed: true,
          timeMs: 120,
          costUsd: 0.02,
        },
      ];
    });
    seedFinishedRun(newSte, runId, rows);

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/recommend_models",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: newSte,
        run_id: runId,
        intent: "add_feature",
        idempotency_key: "rec-add-feature",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      named_model: { id: string; backups: string[] } | null;
    };
    assert.ok(body.named_model);
    assert.equal(body.named_model!.id, "google/gemini-flash-1.5");
    assert.ok(!body.named_model!.backups.includes("openai/gpt-4o-mini"));
  });
});
