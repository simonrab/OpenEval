import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createOpenRouterClient } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
import { deriveWrapKey, storeKey } from "../src/keys.js";
import {
  authHeaders,
  seedFiveTrustedEvals,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

const LIVE = process.env.EVALROUTER_LIVE === "1";

describe("live OpenRouter integration", { skip: !LIVE }, () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let keysRef: string;

  beforeEach(async () => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY required when EVALROUTER_LIVE=1");
    }

    dir = mkdtempSync(join(tmpdir(), "evalrouter-live-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: createOpenRouterClient(),
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
    keysRef = storeKey(db, deriveWrapKey(TEST_API_KEY), {
      projectId,
      secret: apiKey,
      provider: "openrouter",
    });
    db.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs one tiny eval against real OpenRouter", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        models: ["openai/gpt-4o-mini"],
        max_eval_spend_usd: 0.25,
        keys_ref: keysRef,
        idempotency_key: `live-${Date.now()}`,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { run_id: string; status: string };
    assert.ok(body.run_id.startsWith("run_"));

    const report = await waitForRunComplete(app, projectId, body.run_id, 120_000);
    assert.equal(report.status, "succeeded");
    assert.equal((report as { live_traffic_changed: boolean }).live_traffic_changed, false);
    const rows = (report as { rows?: Array<{ passed: boolean }> }).rows ?? [];
    assert.ok(rows.length >= 1);
  });
});

describe("live OpenRouter integration (skipped)", { skip: LIVE }, () => {
  it("skips when EVALROUTER_LIVE is unset", () => {
    assert.notEqual(process.env.EVALROUTER_LIVE, "1");
  });
});
