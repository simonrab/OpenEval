import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";
import {
  authHeaders,
  seedFiveTrustedEvals,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

describe("cost cap (J7 partial)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let keysRef: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-cap-"));
    sqlitePath = join(dir, "evalrouter.sqlite");

    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: createMockOpenRouter({ "*": '{"line_items":[],"total_cents":1}' }, 0.05),
    });

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
    keysRef = await storeCustomerKey(db, projectId);
    db.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns partial with COST_CAP_EXCEEDED and lists scored vs not scored", async () => {
    const runRes = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        models: ["openai/gpt-4o-mini", "google/gemini-flash-1.5"],
        max_eval_spend_usd: 0.01,
        keys_ref: keysRef,
        idempotency_key: "cap-partial",
      },
    });
    assert.equal(runRes.statusCode, 200);
    const { run_id: runId } = runRes.json() as { run_id: string };

    const report = await waitForRunComplete(app, projectId, runId);
    assert.equal(report.status, "partial");
    assert.equal(report.code, ErrorCode.COST_CAP_EXCEEDED);
    assert.ok((report.eval_ids_scored as string[]).length >= 1);
    assert.ok((report.eval_ids_not_scored as string[]).length >= 1);
    assert.notEqual(report.ci_exit, 0);
  });

  it("partial pass is not ci_exit 0", async () => {
    const runRes = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        models: ["openai/gpt-4o-mini"],
        max_eval_spend_usd: 0.01,
        keys_ref: keysRef,
        idempotency_key: "cap-not-pass",
      },
    });
    const { run_id: runId } = runRes.json() as { run_id: string };
    const report = await waitForRunComplete(app, projectId, runId);
    assert.equal(report.status, "partial");
    assert.notEqual(report.ci_exit, 0);
  });
});

describe("spend gate unit", () => {
  it("stops between evals when cap exceeded", async () => {
    const { canStartEval, createSpendTracker, recordSpend } = await import(
      "../src/runner/spend.js"
    );
    const t = createSpendTracker(0.1);
    assert.equal(canStartEval(t), true);
    recordSpend(t, 0.06);
    assert.equal(canStartEval(t), true);
    recordSpend(t, 0.05);
    assert.equal(canStartEval(t), false);
    assert.equal(t.exceeded, true);
  });
});
