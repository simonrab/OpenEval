import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { runEvalsOutputSchema } from "../src/tools/schema.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";
import {
  authHeaders,
  createTestApp,
  seedFiveTrustedEvals,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

describe("run_evals (J2/J4)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let keysRef: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-run-"));
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
    keysRef = await storeCustomerKey(db, projectId);
    db.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns immediate run_id and queued status", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        models: ["openai/gpt-4o-mini", "google/gemini-flash-1.5"],
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: "run-immediate-1",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const parsed = runEvalsOutputSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed));
    assert.match((body as { run_id: string }).run_id, /^run_/);
    assert.ok(["queued", "running"].includes((body as { status: string }).status));
    assert.equal(
      (body as { next_action: { tool: string } }).next_action.tool,
      "get_eval_report",
    );
  });

  it("scores trusted code evals with programs, not mark queue", async () => {
    const runRes = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        models: ["openai/gpt-4o-mini"],
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: "run-score-1",
      },
    });
    const { run_id: runId } = runRes.json() as { run_id: string };
    const report = await waitForRunComplete(app, projectId, runId);
    assert.equal(report.status, "succeeded");
    const items = report.items as Array<{ passed: boolean }>;
    assert.ok(items.length >= 1);
    assert.ok((report.eval_ids_scored as string[]).length >= 5);
  });

  it("returns need_more_evals when trusted count is below bar", async () => {
    const db = new Database(sqlitePath);
    const smallProject = "prj_small";
    db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
      smallProject,
      new Date().toISOString(),
    );
    const jobId = "job_small";
    db.prepare(
      `INSERT INTO jobs (id, project_id, description, limits, created_at)
       VALUES (?, ?, 'x', NULL, ?)`,
    ).run(jobId, smallProject, new Date().toISOString());
    const { createEvalSetVersion1 } = await import("../src/eval-set.js");
    const { fiveCodeDrafts } = await import("./helpers/run-fixtures.js");
    const drafts = fiveCodeDrafts().slice(0, 3);
    const created = createEvalSetVersion1(db, {
      projectId: smallProject,
      jobId,
      drafts,
    });
    for (const ev of created.evals) {
      db.prepare(`UPDATE evals SET status = 'trusted' WHERE id = ?`).run(
        ev.eval_id,
      );
    }
    const pkr = await storeCustomerKey(db, smallProject);
    db.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: smallProject,
        eval_set_id: created.evalSetId,
        max_eval_spend_usd: 1,
        keys_ref: pkr,
        idempotency_key: "run-need-more",
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.need_more_evals);
  });

  it("returns PROJECT_NOT_FOUND for bad project", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: "prj_missing",
        eval_set_id: evalSetId,
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: "run-bad-project",
      },
    });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { code: string }).code, ErrorCode.PROJECT_NOT_FOUND);
  });

  it("returns SUITE_NOT_FOUND for bad eval set", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: "ste_missing",
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: "run-bad-suite",
      },
    });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { code: string }).code, ErrorCode.SUITE_NOT_FOUND);
  });

  it("requires keys_ref and never reads OPENROUTER_API_KEY from env", async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "env-key-should-not-be-used";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/tools/run_evals",
        headers: authHeaders(),
        payload: {
          project_id: projectId,
          eval_set_id: evalSetId,
          max_eval_spend_usd: 1,
          idempotency_key: "run-no-key",
        },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(
        (res.json() as { code: string }).code,
        ErrorCode.INVALID_INPUT,
      );
    } finally {
      if (prev === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = prev;
      }
    }
  });

  it("returns COST_CAP_REQUIRED for recheck with zero cap", async () => {
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
        named_model: { rec_id: "rec_x", model_id: "openai/gpt-4o-mini" },
        idempotency_key: "run-recheck-cap",
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(
      (res.json() as { code: string }).code,
      ErrorCode.COST_CAP_REQUIRED,
    );
  });

  it("is idempotent for the same idempotency_key", async () => {
    const payload = {
      project_id: projectId,
      eval_set_id: evalSetId,
      models: ["openai/gpt-4o-mini"],
      max_eval_spend_usd: 1,
      keys_ref: keysRef,
      idempotency_key: "run-idem",
    };
    const a = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload,
    });
    const b = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload,
    });
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.deepEqual(a.json(), b.json());
  });

  it("default models is a current catalog short list, not the frozen five", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: "run-default-catalog",
      },
    });
    assert.equal(res.statusCode, 200);
    const { run_id: runId } = res.json() as { run_id: string };
    const db = new Database(sqlitePath, { readonly: true });
    const row = db
      .prepare("SELECT models FROM runs WHERE id = ?")
      .get(runId) as { models: string };
    db.close();
    const models = JSON.parse(row.models) as string[];
    assert.ok(models.length >= 1);
    assert.ok(models.length <= 5);
    assert.ok(models.includes("openai/gpt-4.1-nano"));
    assert.ok(models.includes("google/gemini-2.5-flash"));
    assert.ok(!models.includes("google/gemini-flash-1.5"));
    assert.ok(!models.includes("anthropic/claude-3-haiku"));
    assert.ok(!models.includes("mistralai/mistral-7b-instruct"));
    assert.ok(!models.includes("meta-llama/llama-3.1-8b-instruct"));
  });

  it("default list drops models that cannot see images when the job needs images", async () => {
    const db = new Database(sqlitePath);
    db.prepare(
      `UPDATE jobs SET limits = ? WHERE id = (
         SELECT job_id FROM eval_sets WHERE id = ?
       )`,
    ).run(JSON.stringify({ needs_images: true }), evalSetId);
    db.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: "run-default-images",
      },
    });
    assert.equal(res.statusCode, 200);
    const { run_id: runId } = res.json() as { run_id: string };
    const read = new Database(sqlitePath, { readonly: true });
    const row = read
      .prepare("SELECT models FROM runs WHERE id = ?")
      .get(runId) as { models: string };
    read.close();
    const models = JSON.parse(row.models) as string[];
    assert.ok(models.includes("openai/gpt-4.1-nano"));
    assert.ok(!models.includes("mistralai/mistral-small-3.1"));
    assert.ok(!models.includes("meta-llama/llama-3.3-70b-instruct"));
  });

  it("returns does_not_work when no current model fits limits", async () => {
    const db = new Database(sqlitePath);
    db.prepare(
      `UPDATE jobs SET limits = ? WHERE id = (
         SELECT job_id FROM eval_sets WHERE id = ?
       )`,
    ).run(
      JSON.stringify({ allowed_models: ["this-vendor-does-not-exist/*"] }),
      evalSetId,
    );
    db.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: "run-default-none-fit",
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { code: string }).code, ErrorCode.does_not_work);
  });

  it("stores a short sanitized OpenRouter HTTP failure reason", async () => {
    await app.close();
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: {
        async chatCompletion() {
          throw new Error(
            `OpenRouter 429: sk-or-v1-super-secret ${"x".repeat(400)}`,
          );
        },
      },
    });

    const runRes = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        models: ["openai/gpt-4o-mini"],
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: "run-http-failure-reason",
      },
    });
    assert.equal(runRes.statusCode, 200);
    const { run_id: runId } = runRes.json() as { run_id: string };
    const report = await waitForRunComplete(app, projectId, runId);
    const reason = (
      report.items as Array<{ reason_short: string }>
    )[0]!.reason_short;

    assert.match(reason, /OpenRouter 429/);
    assert.doesNotMatch(reason, /sk-or-v1/);
    assert.ok(reason.length <= 240);
    assert.notEqual(reason, "model call failed");
  });
});
