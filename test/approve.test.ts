import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { approveToken } from "../src/routes/approve.js";
import {
  authHeaders,
  createTestApp,
  seedFiveTrustedEvals,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

describe("approve screen (J4)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let keysRef: string;
  let customerEnvPath: string;
  let customerEnvBefore: string | null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-approve-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    customerEnvPath = join(dir, "customer.env");
    writeFileSync(customerEnvPath, "MODEL=old/provider-model\n");
    customerEnvBefore = readFileSync(customerEnvPath, "utf8");
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

  async function recommend(): Promise<string> {
    const runRes = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        models: ["openai/gpt-4o-mini", "google/gemini-flash-1.5"],
        max_eval_spend_usd: 5,
        keys_ref: keysRef,
        idempotency_key: `run-approve-${Date.now()}`,
      },
    });
    const { run_id: runId } = runRes.json() as { run_id: string };
    await waitForRunComplete(app, projectId, runId);

    const recRes = await app.inject({
      method: "POST",
      url: "/v1/tools/recommend_models",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        run_id: runId,
        intent: "new_feature",
        idempotency_key: `rec-approve-${Date.now()}`,
      },
    });
    assert.equal(recRes.statusCode, 200);
    return (recRes.json() as { recommendation_id: string }).recommendation_id;
  }

  it("GET HTML shows named model, backups, quality, time, cost", async () => {
    const recId = await recommend();
    const token = approveToken(TEST_API_KEY, recId);
    const res = await app.inject({
      method: "GET",
      url: `/approve?recommendation_id=${encodeURIComponent(recId)}&token=${token}`,
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    const html = res.body;
    const db = new Database(sqlitePath, { readonly: true });
    const rec = db
      .prepare(
        `SELECT named_model_id, quality_json, time_json, cost_usd
         FROM recommendations WHERE id = ?`,
      )
      .get(recId) as {
      named_model_id: string;
      quality_json: string;
      time_json: string;
      cost_usd: number;
    };
    db.close();
    const quality = JSON.parse(rec.quality_json) as { n_pass: number; n_fail: number };
    const time = JSON.parse(rec.time_json) as { p50: number; p95: number };
    assert.match(html, /Named model recommendation/i);
    assert.match(html, /live traffic/i);
    assert.match(html, new RegExp(rec.named_model_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(`${quality.n_pass} pass`));
    assert.match(html, new RegExp(`${Math.round(time.p50)}`));
    assert.match(html, new RegExp(rec.cost_usd.toFixed(4)));
    assert.match(html, /Failing evals/);
    assert.doesNotMatch(html, /unit test/i);
  });

  it("approve does not write customer .env", async () => {
    const recId = await recommend();
    const db = new Database(sqlitePath);
    const rec = db
      .prepare("SELECT named_model_id FROM recommendations WHERE id = ?")
      .get(recId) as { named_model_id: string };
    db.close();

    const res = await app.inject({
      method: "POST",
      url: "/approve",
      headers: { "content-type": "application/json" },
      payload: {
        recommendation_id: recId,
        token: approveToken(TEST_API_KEY, recId),
        decision: "approved",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      decision: string;
      live_traffic_changed: boolean;
    };
    assert.equal(body.decision, "approved");
    assert.equal(body.live_traffic_changed, false);

    assert.equal(readFileSync(customerEnvPath, "utf8"), customerEnvBefore);

    writeFileSync(
      customerEnvPath,
      `MODEL=${rec.named_model_id}\n`,
    );
    assert.notEqual(readFileSync(customerEnvPath, "utf8"), customerEnvBefore);
  });

  it("shows failing evals when no model works", async () => {
    const recId = "rec_does_not_work";
    const db = new Database(sqlitePath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs
        (id, project_id, eval_set_id, eval_set_version, status, code, models,
         max_eval_spend_usd, keys_ref, intent, named_model, new_failures,
         spend_usd, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'succeeded', NULL, '[]', 5, ?, 'new_feature', NULL, NULL, 0, ?, ?, ?)`,
    ).run("run_dnw", projectId, evalSetId, keysRef, "run-dnw", now, now);
    db.prepare(
      `INSERT INTO recommendations
        (id, project_id, eval_set_id, run_id, intent, named_model_id,
         backup_model_ids, quality_json, time_json, cost_usd, failing_eval_ids, created_at)
       VALUES (?, ?, ?, 'run_dnw', 'new_feature', NULL, '[]', '{"n_pass":0,"n_fail":1}',
               '{"p50":0,"p95":0}', 0, ?, ?)`,
    ).run(recId, projectId, evalSetId, JSON.stringify(["cas_fail_1"]), now);
    db.close();

    const token = approveToken(TEST_API_KEY, recId);
    const res = await app.inject({
      method: "GET",
      url: `/approve?recommendation_id=${encodeURIComponent(recId)}&token=${token}`,
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /\(none\)/);
    assert.match(res.body, /cas_fail_1/);
  });

  it("GET without a valid token is rejected", async () => {
    const recId = await recommend();
    const res = await app.inject({
      method: "GET",
      url: `/approve?recommendation_id=${encodeURIComponent(recId)}&token=nope`,
    });
    assert.ok(res.statusCode === 401 || res.statusCode === 403);
  });
});
