import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { getEvalReportOutputSchema } from "../src/tools/schema.js";
import {
  authHeaders,
  createTestApp,
  seedFiveTrustedEvals,
  storeCustomerKey,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

describe("get_eval_report (J8)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let evalIds: string[];
  let keysRef: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-report-"));
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

  async function startRun(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        models: ["openai/gpt-4o-mini"],
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: `run-${Date.now()}-${Math.random()}`,
      },
    });
    return (res.json() as { run_id: string }).run_id;
  }

  function seedFinishedRun(
    runId: string,
    rows: Array<{
      modelId: string;
      evalId: string;
      passed: boolean;
      reasonShort: string;
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
       VALUES (?, ?, ?, ?, ?, 10, 0.01, ?)`,
    );
    for (const row of rows) {
      insert.run(
        runId,
        row.evalId,
        row.modelId,
        row.passed ? 1 : 0,
        row.reasonShort,
        now,
      );
    }
    db.close();
  }

  it("polls with next_action while queued or running", async () => {
    const runId = await startRun();
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/get_eval_report",
      headers: authHeaders(),
      payload: { project_id: projectId, run_id: runId },
    });
    const body = res.json() as {
      status: string;
      next_action: { tool: string; args: { run_id?: string } };
    };
    if (body.status === "queued" || body.status === "running") {
      assert.equal(body.next_action.tool, "get_eval_report");
      assert.equal(body.next_action.args.run_id, runId);
    }
  });

  it("returns summary, report_url, live_traffic_changed false, ci_exit", async () => {
    const runId = await startRun();
    const body = await waitForRunComplete(app, projectId, runId);
    const parsed = getEvalReportOutputSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed));

    assert.equal(body.live_traffic_changed, false);
    assert.ok(typeof body.ci_exit === "number");
    assert.match((body.report_url as string), /^http:\/\/test\.local\/report\?token=/);
    const summary = body.summary as {
      n_pass: number;
      n_fail: number;
      cost_usd: number;
      time_ms: { p50: number; p95: number };
    };
    assert.ok(summary.n_pass + summary.n_fail >= 1);
    assert.ok(typeof summary.cost_usd === "number");
    assert.ok(typeof summary.time_ms.p50 === "number");
    assert.ok(Array.isArray(body.models));
    assert.ok((body.models as unknown[]).length >= 1);
    assert.ok(!("trace" in body));
    assert.ok(!("output" in body));
  });

  it("paginates rows with cursor", async () => {
    const runId = await startRun();
    await waitForRunComplete(app, projectId, runId);

    const page1 = await app.inject({
      method: "POST",
      url: "/v1/tools/get_eval_report",
      headers: authHeaders(),
      payload: { project_id: projectId, run_id: runId, limit: 2 },
    });
    const b1 = page1.json() as {
      items: unknown[];
      next_cursor: string | null;
      truncated: boolean;
    };
    assert.equal(b1.items.length, 2);

    if (b1.next_cursor) {
      const page2 = await app.inject({
        method: "POST",
        url: "/v1/tools/get_eval_report",
        headers: authHeaders(),
        payload: {
          project_id: projectId,
          run_id: runId,
          limit: 2,
          cursor: b1.next_cursor,
        },
      });
      const b2 = page2.json() as { items: unknown[] };
      assert.ok(b2.items.length >= 1);
    }
  });

  it("sets ci_exit 0 only on complete pass", async () => {
    const runId = await startRun();
    const body = await waitForRunComplete(app, projectId, runId);
    if (body.status === "succeeded" && (body.summary as { n_fail: number }).n_fail === 0) {
      assert.equal(body.ci_exit, 0);
    } else {
      assert.notEqual(body.ci_exit, 0);
    }
  });

  it("serves read-only report.html", async () => {
    const runId = await startRun();
    const report = await waitForRunComplete(app, projectId, runId);
    const reportUrl = new URL(report.report_url as string);
    const res = await app.inject({
      method: "GET",
      url: `${reportUrl.pathname}${reportUrl.search}`,
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Eval run report/);
    assert.match(res.body, new RegExp(runId));
    assert.doesNotMatch(res.body, /Authorization/i);
    assert.doesNotMatch(res.body, /\bfetch\s*\(/i);
    assert.doesNotMatch(res.body, /\bdashboard\b/i);
  });

  it("rejects report hydration without a valid signed token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/report?token=nope",
    });
    assert.equal(res.statusCode, 401);
  });

  it("does not fail an eval globally when any candidate model passed it", async () => {
    const runId = "run_candidate_mix";
    seedFinishedRun(runId, evalIds.flatMap((evalId) => [
      {
        modelId: "openai/gpt-4o-mini",
        evalId,
        passed: true,
        reasonShort: "ok",
      },
      {
        modelId: "google/gemini-2.0-flash-001",
        evalId,
        passed: evalId !== evalIds[0],
        reasonShort: evalId === evalIds[0] ? "invalid JSON" : "ok",
      },
    ]));

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/get_eval_report",
      headers: authHeaders(),
      payload: { project_id: projectId, run_id: runId },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      summary: { n_pass: number; n_fail: number };
      failing_eval_ids: string[];
      items: Array<{ eval_id: string; passed: boolean; reason_short: string }>;
      models: Array<{
        model_id: string;
        n_pass: number;
        n_fail: number;
        failing_eval_ids: string[];
      }>;
    };

    assert.equal(body.summary.n_pass, evalIds.length);
    assert.equal(body.summary.n_fail, 0);
    assert.deepEqual(body.failing_eval_ids, []);
    assert.equal(body.items.find((item) => item.eval_id === evalIds[0])?.passed, true);

    const failedCandidate = body.models.find(
      (model) => model.model_id === "google/gemini-2.0-flash-001",
    );
    assert.ok(failedCandidate);
    assert.equal(failedCandidate!.n_fail, 1);
    assert.deepEqual(failedCandidate!.failing_eval_ids, [evalIds[0]]);
  });
});
