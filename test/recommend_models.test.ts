import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
import { recommendModelsOutputSchema } from "../src/tools/schema.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";
import {
  authHeaders,
  createTestApp,
  seedFiveTrustedEvals,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

const BAD_JSON = '{"line_items":[{"sku":"a","qty":1}]}';

describe("recommend_models (J4)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let evalIds: string[];
  let keysRef: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-recommend-"));
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
    const seeded = seedFiveTrustedEvals(db, projectId);
    evalSetId = seeded.evalSetId;
    evalIds = seeded.evalIds;
    keysRef = await storeCustomerKey(db, projectId);
    db.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function runEvals(
    models: string[],
    idempotencyKey: string,
  ): Promise<string> {
    const runRes = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        models,
        max_eval_spend_usd: 5,
        keys_ref: keysRef,
        idempotency_key: idempotencyKey,
      },
    });
    assert.equal(runRes.statusCode, 200);
    const { run_id: runId } = runRes.json() as { run_id: string };
    await waitForRunComplete(app, projectId, runId);
    return runId;
  }

  function seedFinishedRun(
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
       VALUES (?, ?, ?, 1, 'succeeded', NULL, ?, 5, ?, 'new_feature', NULL, NULL, 0.5, ?, ?, ?)`,
    ).run(
      runId,
      projectId,
      evalSetId,
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

  it("returns rec_ and named model after a finished run", async () => {
    const runId = await runEvals(
      ["openai/gpt-4o-mini", "google/gemini-flash-1.5"],
      "run-rec-1",
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/recommend_models",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        run_id: runId,
        intent: "new_feature",
        idempotency_key: "rec-1",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(recommendModelsOutputSchema.safeParse(body).success, true);
    assert.match((body as { recommendation_id: string }).recommendation_id, /^rec_/);
    const named = (body as { named_model: { id: string; backups: string[] } | null })
      .named_model;
    assert.ok(named);
    assert.ok(named!.backups.length <= 2);
    assert.equal(
      (body as { next_action: { tool: string | null } }).next_action.tool,
      null,
    );
  });

  it("returns need_more_evals when trusted count is below bar", async () => {
    const db = new Database(sqlitePath);
    const toDraft = evalIds.slice(0, 4);
    for (const id of toDraft) {
      db.prepare("UPDATE evals SET status = 'draft' WHERE id = ?").run(id);
    }
    db.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/recommend_models",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        intent: "new_feature",
        idempotency_key: "rec-few",
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.need_more_evals);
  });

  it("returns does_not_work when no model passes evals", async () => {
    await app.close();
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: createMockOpenRouter({ "*": BAD_JSON }),
    });

    const runId = await runEvals(["openai/gpt-4o-mini"], "run-fail-all");
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/recommend_models",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        run_id: runId,
        intent: "new_feature",
        idempotency_key: "rec-fail",
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.does_not_work);
    assert.ok(Array.isArray(body.failing_eval_ids));
    assert.ok((body.failing_eval_ids as string[]).length >= 1);
    assert.match(body.next_action.ask_human ?? "", /failing_eval_ids/i);
  });

  it("points to get_eval_report when run is still going", async () => {
    const runId = "run_still_going_test";
    const db = new Database(sqlitePath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs
        (id, project_id, eval_set_id, eval_set_version, status, code, models,
         max_eval_spend_usd, keys_ref, intent, named_model, new_failures,
         spend_usd, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'running', NULL, ?, 5, ?, 'new_feature', NULL, NULL, 0, ?, ?, ?)`,
    ).run(
      runId,
      projectId,
      evalSetId,
      JSON.stringify(["openai/gpt-4o-mini"]),
      keysRef,
      "run-still-seed",
      now,
      now,
    );
    db.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/recommend_models",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        run_id: runId,
        intent: "new_feature",
        idempotency_key: "rec-still",
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal(body.next_action.tool, "get_eval_report");
  });

  it("drops models over max_wait_ms from job limits", async () => {
    const db = new Database(sqlitePath);
    db.prepare(
      `UPDATE jobs SET limits = ? WHERE id = (
         SELECT job_id FROM eval_sets WHERE id = ?
       )`,
    ).run(JSON.stringify({ max_wait_ms: 50 }), evalSetId);
    db.close();

    const runId = "run_slow_limit_test";
    const rows = evalIds.flatMap((evalId) => [
      {
        modelId: "openai/gpt-4o-mini",
        evalId,
        passed: true,
        timeMs: 5000,
        costUsd: 0.01,
      },
      {
        modelId: "google/gemini-flash-1.5",
        evalId,
        passed: true,
        timeMs: 10,
        costUsd: 0.02,
      },
    ]);
    seedFinishedRun(runId, rows);

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/recommend_models",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        run_id: runId,
        intent: "new_feature",
        idempotency_key: "rec-slow",
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

  it("suggests run_evals when run_id is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/recommend_models",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        intent: "new_feature",
        idempotency_key: "rec-no-run",
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal(body.next_action.tool, "run_evals");
  });
});
