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
    assert.match((body.report_url as string), /\/report\?run_id=/);
    const summary = body.summary as {
      n_pass: number;
      n_fail: number;
      cost_usd: number;
      time_ms: { p50: number; p95: number };
    };
    assert.ok(summary.n_pass + summary.n_fail >= 1);
    assert.ok(typeof summary.cost_usd === "number");
    assert.ok(typeof summary.time_ms.p50 === "number");
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
    const res = await app.inject({ method: "GET", url: "/report?run_id=run_demo" });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Eval run report/);
    assert.doesNotMatch(res.body, /\bdashboard\b/i);
  });
});
