import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { validateRecheckNamedModel } from "../src/ci/recheck.js";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
import { listMembers } from "../src/eval-set.js";
import { ErrorCode } from "../src/tools/types.js";
import {
  authHeaders,
  createTestApp,
  seedFiveTrustedEvals,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

const BAD_JSON = '{"line_items":[{"sku":"a","qty":1}]}';

function seedRecommendation(
  db: Database.Database,
  input: {
    recId: string;
    projectId: string;
    evalSetId: string;
    runId: string;
    namedModelId: string;
    keysRef: string;
    backups?: string[];
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs
      (id, project_id, eval_set_id, eval_set_version, status, code, models,
       max_eval_spend_usd, keys_ref, intent, named_model, new_failures,
       spend_usd, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'succeeded', NULL, ?, 5, ?, 'new_feature', NULL, NULL, 0.5, ?, ?, ?)`,
  ).run(
    input.runId,
    input.projectId,
    input.evalSetId,
    JSON.stringify([input.namedModelId]),
    input.keysRef,
    `seed-${input.runId}`,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO recommendations
      (id, project_id, eval_set_id, run_id, intent, named_model_id,
       backup_model_ids, quality_json, time_json, cost_usd, failing_eval_ids, created_at)
     VALUES (?, ?, ?, ?, 'new_feature', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.recId,
    input.projectId,
    input.evalSetId,
    input.runId,
    input.namedModelId,
    JSON.stringify(input.backups ?? ["google/gemini-flash-1.5"]),
    JSON.stringify({ n_pass: 5, n_fail: 0 }),
    JSON.stringify({ p50: 100, p95: 200 }),
    0.25,
    JSON.stringify([]),
    now,
  );
}

describe("recheck (J7)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let evalIds: string[];
  let keysRef: string;
  let recId: string;
  let namedModelId: string;
  let priorRunId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-recheck-"));
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

    priorRunId = "run_prior_recommend";
    recId = "rec_test_recheck_001";
    namedModelId = "openai/gpt-4o-mini";
    seedRecommendation(db, {
      recId,
      projectId,
      evalSetId,
      runId: priorRunId,
      namedModelId,
      keysRef,
    });
    db.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function startRecheck(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        max_eval_spend_usd: 5,
        keys_ref: keysRef,
        intent: "recheck",
        named_model: { rec_id: recId, model_id: namedModelId },
        idempotency_key: `recheck-${Date.now()}-${Math.random()}`,
        ...overrides,
      },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    return (res.json() as { run_id: string }).run_id;
  }

  it("returns NAMED_MODEL_MISMATCH when rec_id does not match model_id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        intent: "recheck",
        named_model: { rec_id: recId, model_id: "wrong/model" },
        idempotency_key: "recheck-mismatch",
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(
      (res.json() as { code: string }).code,
      ErrorCode.NAMED_MODEL_MISMATCH,
    );
  });

  it("validateRecheckNamedModel rejects wrong eval set", () => {
    const db = new Database(sqlitePath);
    const err = validateRecheckNamedModel(db, "ste_other", {
      rec_id: recId,
      model_id: namedModelId,
    });
    db.close();
    assert.ok(err);
    assert.equal(err!.code, ErrorCode.NAMED_MODEL_MISMATCH);
  });

  it("recheck runs only the named model and passes with same scoring", async () => {
    const runId = await startRecheck();
    const report = await waitForRunComplete(app, projectId, runId);

    assert.equal(report.status, "succeeded");
    assert.equal(report.code, null);
    assert.equal(report.ci_exit, 0);
    assert.equal(report.live_traffic_changed, false);

    const db = new Database(sqlitePath);
    const run = db
      .prepare("SELECT models FROM runs WHERE id = ?")
      .get(runId) as { models: string };
    const models = JSON.parse(run.models) as string[];
    assert.deepEqual(models, [namedModelId]);

    const results = db
      .prepare("SELECT DISTINCT model_id FROM run_results WHERE run_id = ?")
      .all(runId) as Array<{ model_id: string }>;
    assert.equal(results.length, 1);
    assert.equal(results[0]!.model_id, namedModelId);
    db.close();

    const summary = report.summary as { n_pass: number; n_fail: number };
    assert.equal(summary.n_fail, 0);
    assert.ok(summary.n_pass >= 5);
  });

  it("recheck does not mutate the frozen eval set", async () => {
    const dbBefore = new Database(sqlitePath);
    const membersBefore = listMembers(dbBefore, evalSetId);
    const versionBefore = (
      dbBefore
        .prepare("SELECT version FROM eval_sets WHERE id = ?")
        .get(evalSetId) as { version: number }
    ).version;
    dbBefore.close();

    const runId = await startRecheck();
    await waitForRunComplete(app, projectId, runId);

    const dbAfter = new Database(sqlitePath);
    const membersAfter = listMembers(dbAfter, evalSetId);
    const versionAfter = (
      dbAfter
        .prepare("SELECT version FROM eval_sets WHERE id = ?")
        .get(evalSetId) as { version: number }
    ).version;
    dbAfter.close();

    assert.equal(versionAfter, versionBefore);
    assert.equal(membersAfter.length, membersBefore.length);
    for (let i = 0; i < membersBefore.length; i++) {
      assert.equal(membersAfter[i]!.eval_id, membersBefore[i]!.eval_id);
      assert.deepEqual(
        membersAfter[i]!.program_check,
        membersBefore[i]!.program_check,
      );
      assert.equal(membersAfter[i]!.status, membersBefore[i]!.status);
    }
  });

  it("returns need_new_model when the named model now fails", async () => {
    await app.close();
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: createMockOpenRouter({ "*": BAD_JSON }),
    });

    const runId = await startRecheck();
    const report = await waitForRunComplete(app, projectId, runId);

    assert.equal(report.status, "succeeded");
    assert.equal(report.code, ErrorCode.need_new_model);
    assert.notEqual(report.ci_exit, 0);
    assert.equal(report.live_traffic_changed, false);
    assert.ok((report.failing_eval_ids as string[]).length >= 1);
    assert.equal(
      (report.summary as { named_model_still_passes: boolean | null })
        .named_model_still_passes,
      false,
    );
  });

  it("returns evals_missing_new_failures when new_failures are not in the set", async () => {
    const runId = await startRecheck({
      new_failures: [
        {
          input: { prompt: "totally new bad example not in eval set" },
        },
      ],
    });
    const report = await waitForRunComplete(app, projectId, runId);

    assert.equal(report.code, ErrorCode.evals_missing_new_failures);
    assert.notEqual(report.ci_exit, 0);
    assert.equal(
      (report.summary as { new_failures_missing_from_evals: boolean })
        .new_failures_missing_from_evals,
      true,
    );
    assert.equal(
      (report.next_action as { tool: string | null }).tool,
      "register_failure",
    );
  });

  it("cost cap mid-run stores partial and fails the build", async () => {
    await app.close();
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: createMockOpenRouter({ "*": '{"line_items":[],"total_cents":1}' }, 0.05),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        max_eval_spend_usd: 0.01,
        keys_ref: keysRef,
        intent: "recheck",
        named_model: { rec_id: recId, model_id: namedModelId },
        idempotency_key: "recheck-cap",
      },
    });
    const runId = (res.json() as { run_id: string }).run_id;
    const report = await waitForRunComplete(app, projectId, runId);

    assert.equal(report.status, "partial");
    assert.equal(report.code, ErrorCode.COST_CAP_EXCEEDED);
    assert.notEqual(report.ci_exit, 0);
    assert.equal(report.live_traffic_changed, false);
    assert.ok((report.eval_ids_scored as string[]).length >= 1);
    assert.ok((report.eval_ids_not_scored as string[]).length >= 1);
  });
});

describe("ci-recheck.sh", () => {
  it("does not call recommend_models or write .env", () => {
    const script = readFileSync(
      join(process.cwd(), "examples/ci-recheck.sh"),
      "utf8",
    );
    assert.doesNotMatch(script, /\/v1\/tools\/recommend_models/);
    assert.doesNotMatch(script, />\s*\.env|>>\s*\.env/);
    assert.match(script, /run_evals/);
    assert.match(script, /get_eval_report/);
    assert.match(script, /ci_exit/);
  });
});
