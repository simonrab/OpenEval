import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
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

type NextAction = {
  tool: string | null;
  args: Record<string, unknown>;
  ask_human: string | null;
};

function seedRecommendation(
  db: Database.Database,
  input: {
    recId: string;
    projectId: string;
    evalSetId: string;
    runId: string;
    namedModelId: string;
    keysRef: string;
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
     VALUES (?, ?, ?, ?, 'new_feature', ?, '[]', ?, ?, 0.1, '[]', ?)`,
  ).run(
    input.recId,
    input.projectId,
    input.evalSetId,
    input.runId,
    input.namedModelId,
    JSON.stringify({ n_pass: 5, n_fail: 0 }),
    JSON.stringify({ p50: 100, p95: 200 }),
    now,
  );
}

describe("M7 error branches", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let evalIds: string[];
  let keysRef: string;
  let recId: string;
  let namedModelId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-error-branches-"));
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
    recId = "rec_err_branch";
    namedModelId = "openai/gpt-4o-mini";
    seedRecommendation(db, {
      recId,
      projectId,
      evalSetId,
      runId: "run_prior_err",
      namedModelId,
      keysRef,
    });
    db.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("JOB_UNCLEAR asks what good means", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "make it nicer",
        idempotency_key: "err-unclear",
      },
    });
    const body = res.json() as { code: string; next_action: NextAction };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.JOB_UNCLEAR);
    assert.equal(body.next_action.tool, null);
    assert.equal(body.next_action.ask_human, "what good means");
  });

  it("PROJECT_NOT_FOUND asks for a real prj_", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        project_id: "prj_missing",
        description: "Return JSON with line_items[] and total_cents.",
        idempotency_key: "err-prj",
      },
    });
    const body = res.json() as { code: string; next_action: NextAction };
    assert.equal(body.code, ErrorCode.PROJECT_NOT_FOUND);
    assert.equal(body.next_action.ask_human, "Pass a real prj_");
  });

  it("SUITE_NOT_FOUND asks for a saved ste_", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: "ste_missing",
        idempotency_key: "err-ste",
      },
    });
    const body = res.json() as { code: string; next_action: NextAction };
    assert.equal(body.code, ErrorCode.SUITE_NOT_FOUND);
    assert.equal(body.next_action.ask_human, "Pass a saved ste_");
  });

  it("need_more_evals points at queue_for_labeling", async () => {
    const db = new Database(sqlitePath);
    for (const id of evalIds.slice(0, 4)) {
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
        idempotency_key: "err-few",
      },
    });
    const body = res.json() as { code: string; next_action: NextAction };
    assert.equal(body.code, ErrorCode.need_more_evals);
    assert.equal(body.next_action.tool, "queue_for_labeling");
  });

  it("does_not_work shows failing eval ids", async () => {
    await app.close();
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: createMockOpenRouter({ "*": BAD_JSON }),
    });
    const runRes = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        models: ["openai/gpt-4o-mini"],
        max_eval_spend_usd: 5,
        keys_ref: keysRef,
        idempotency_key: "err-dnw-run",
      },
    });
    const { run_id: runId } = runRes.json() as { run_id: string };
    await waitForRunComplete(app, projectId, runId);
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/recommend_models",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        run_id: runId,
        intent: "new_feature",
        idempotency_key: "err-dnw",
      },
    });
    const body = res.json() as { code: string; next_action: NextAction };
    assert.equal(body.code, ErrorCode.does_not_work);
    assert.match(body.next_action.ask_human ?? "", /failing_eval_ids/);
  });

  it("NAMED_MODEL_MISMATCH asks for the saved named model", async () => {
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
        idempotency_key: "err-mismatch",
      },
    });
    const body = res.json() as { code: string; next_action: NextAction };
    assert.equal(body.code, ErrorCode.NAMED_MODEL_MISMATCH);
    assert.equal(body.next_action.ask_human, "Pass the saved named model");
  });

  it("COST_CAP_REQUIRED retries run_evals with a cap", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        max_eval_spend_usd: 0,
        keys_ref: keysRef,
        intent: "recheck",
        named_model: { rec_id: recId, model_id: namedModelId },
        idempotency_key: "err-cap-req",
      },
    });
    const body = res.json() as { code: string; next_action: NextAction };
    assert.equal(body.code, ErrorCode.COST_CAP_REQUIRED);
    assert.equal(body.next_action.tool, "run_evals");
    assert.equal(body.next_action.args.project_id, projectId);
    assert.equal(body.next_action.args.eval_set_id, evalSetId);
    assert.ok((body.next_action.args.max_eval_spend_usd as number) > 0);
  });

  it("need_new_model next_action is after_failure with current_named_model", async () => {
    await app.close();
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: createMockOpenRouter({ "*": BAD_JSON }),
    });
    const runRes = await app.inject({
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
        idempotency_key: "err-need-new",
      },
    });
    const { run_id: runId } = runRes.json() as { run_id: string };
    const report = await waitForRunComplete(app, projectId, runId);
    assert.equal(report.code, ErrorCode.need_new_model);
    const next = report.next_action as NextAction;
    assert.equal(next.tool, "recommend_models");
    assert.equal(next.args.intent, "after_failure");
    assert.equal(next.args.current_named_model, namedModelId);
    assert.equal(next.args.eval_set_id, evalSetId);
    assert.equal(next.args.run_id, runId);
  });

  it("evals_missing_new_failures includes eval_set_id for register_failure", async () => {
    const runRes = await app.inject({
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
        new_failures: [{ input: { prompt: "brand new bad example" } }],
        idempotency_key: "err-missing-fail",
      },
    });
    const { run_id: runId } = runRes.json() as { run_id: string };
    const report = await waitForRunComplete(app, projectId, runId);
    assert.equal(report.code, ErrorCode.evals_missing_new_failures);
    const next = report.next_action as NextAction;
    assert.equal(next.tool, "register_failure");
    assert.equal(next.args.project_id, projectId);
    assert.equal(next.args.eval_set_id, evalSetId);
  });

  it("COST_CAP_EXCEEDED points at the partial report", async () => {
    await app.close();
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: createMockOpenRouter(
        { "*": '{"line_items":[],"total_cents":1}' },
        0.05,
      ),
    });
    const runRes = await app.inject({
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
        idempotency_key: "err-cap-ex",
      },
    });
    const { run_id: runId } = runRes.json() as { run_id: string };
    const report = await waitForRunComplete(app, projectId, runId);
    assert.equal(report.code, ErrorCode.COST_CAP_EXCEEDED);
    const next = report.next_action as NextAction;
    assert.equal(next.tool, "get_eval_report");
    assert.equal(next.args.run_id, runId);
  });

  it("CI recheck script never calls recommend_models", () => {
    const script = readFileSync(
      join(process.cwd(), "examples/ci-recheck.sh"),
      "utf8",
    );
    assert.doesNotMatch(script, /\/v1\/tools\/recommend_models/);
    assert.doesNotMatch(script, />\s*\.env|>>\s*\.env/);
    assert.match(script, /run_evals/);
    assert.match(script, /get_eval_report/);
  });
});
