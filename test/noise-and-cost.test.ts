import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { aggregateModelStats, pickNamedModel, wilsonInterval } from "../src/rank.js";
import { createOpenRouterClient, type ModelSettings } from "../src/runner/openrouter.js";
import { isRetryableModelError, withRetries } from "../src/runner/retry.js";
import { buildApp } from "../src/server.js";
import {
  authHeaders,
  seedFiveTrustedEvals,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

const GOOD_JSON = '{"line_items":[{"sku":"a","qty":1}],"total_cents":100}';

function fakeFetch(body: unknown, capture?: { body?: Record<string, unknown> }) {
  return (async (_url: string, init?: RequestInit) => {
    if (capture && init?.body) {
      capture.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("OpenRouter client cost", () => {
  it("reads the real charge from usage.cost", async () => {
    const client = createOpenRouterClient(
      fakeFetch({
        model: "openai/gpt-4o-mini-2024-07-18",
        choices: [{ message: { content: "ok" } }],
        usage: { cost: 0.00042, prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
    const res = await client.chatCompletion({ model: "openai/gpt-4o-mini", prompt: "x", apiKey: "k" });
    assert.equal(res.cost_usd, 0.00042);
    assert.equal(res.cost_source, "provider");
    assert.equal(res.prompt_tokens, 100);
    assert.equal(res.completion_tokens, 20);
    assert.equal(res.served_model, "openai/gpt-4o-mini-2024-07-18");
  });

  it("labels a token estimate when no cost is reported", async () => {
    const client = createOpenRouterClient(
      fakeFetch({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 100, completion_tokens: 0 },
      }),
    );
    const res = await client.chatCompletion({ model: "m/x", prompt: "x", apiKey: "k" });
    assert.equal(res.cost_source, "estimate");
    assert.ok(res.cost_usd > 0);
  });

  it("sends candidate settings in the request body", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const client = createOpenRouterClient(
      fakeFetch({ choices: [{ message: { content: "ok" } }], usage: { cost: 0 } }, capture),
    );
    const settings: ModelSettings = {
      temperature: 0,
      max_tokens: 50,
      reasoning_effort: "low",
    };
    await client.chatCompletion({ model: "m/x", prompt: "x", apiKey: "k", settings });
    assert.equal(capture.body?.temperature, 0);
    assert.equal(capture.body?.max_tokens, 50);
    assert.deepEqual(capture.body?.reasoning, { effort: "low" });
  });
});

describe("model call retries", () => {
  it("retries rate limits and server errors only", () => {
    assert.equal(isRetryableModelError(new Error("OpenRouter 429: slow down")), true);
    assert.equal(isRetryableModelError(new Error("OpenRouter 503: down")), true);
    assert.equal(isRetryableModelError(new Error("fetch failed")), true);
    assert.equal(isRetryableModelError(new Error("OpenRouter 400: bad")), false);
    assert.equal(isRetryableModelError(new Error("OpenRouter 404: no model")), false);
  });

  it("returns the value and attempt count after a transient failure", async () => {
    let calls = 0;
    const res = await withRetries(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("OpenRouter 429: slow down");
        return "ok";
      },
      { baseDelayMs: 0 },
    );
    assert.deepEqual(res, { ok: true, value: "ok", attempts: 3 });
  });

  it("stops at once on a non-retryable error", async () => {
    let calls = 0;
    const res = await withRetries(
      async () => {
        calls += 1;
        throw new Error("OpenRouter 401: bad key");
      },
      { baseDelayMs: 0 },
    );
    assert.equal(res.ok, false);
    assert.equal(calls, 1);
  });
});

describe("rank with reps", () => {
  const row = (
    model_id: string,
    eval_id: string,
    passed: boolean,
    extra: Record<string, unknown> = {},
  ) => ({ model_id, eval_id, passed, time_ms: 100, cost_usd: 0.001, ...extra });

  it("fails an eval when any rep fails and marks it flaky", () => {
    const [s] = aggregateModelStats(
      [row("m/a", "e1", true), row("m/a", "e1", false), row("m/a", "e2", true)],
      ["e1", "e2"],
    );
    assert.equal(s!.passedAll, false);
    assert.deepEqual(s!.failingEvalIds, ["e1"]);
    assert.deepEqual(s!.flakyEvalIds, ["e1"]);
    assert.equal(s!.nTrials, 3);
    assert.equal(s!.nTrialPass, 2);
  });

  it("keeps error rows out of the score but blocks the name", () => {
    const [s] = aggregateModelStats(
      [row("m/a", "e1", true), row("m/a", "e2", false, { outcome: "error" })],
      ["e1", "e2"],
    );
    assert.equal(s!.nTrials, 1);
    assert.equal(s!.passRate, 1);
    assert.deepEqual(s!.errorEvalIds, ["e2"]);
    assert.equal(s!.passedAll, false);
  });

  it("uses real tokens for spend per 1k", () => {
    const [s] = aggregateModelStats(
      [row("m/a", "e1", true, { cost_usd: 0.002, prompt_tokens: 900, completion_tokens: 100, cost_source: "provider" })],
      ["e1"],
    );
    assert.equal(s!.spendPer1kUsd, 0.002);
    assert.equal(s!.costSource, "provider");
  });

  it("names a model#label candidate and applies limits to its base model", () => {
    const stats = aggregateModelStats(
      [row("m/a#low", "e1", true), row("m/b", "e1", true, { cost_usd: 0.01 })],
      ["e1"],
    );
    const picked = pickNamedModel(stats, { excluded_models: ["m/b"] });
    assert.equal(picked.outcome, "named");
    assert.equal(picked.outcome === "named" && picked.winner, "m/a#low");
    const blocked = pickNamedModel(stats, { excluded_models: ["m/a"] });
    assert.equal(blocked.outcome === "named" && blocked.winner, "m/b");
  });

  it("computes a Wilson interval", () => {
    const { low, high } = wilsonInterval(10, 10);
    assert.ok(low > 0.69 && low < 0.73);
    assert.equal(high, 1);
  });
});

describe("run_results migration", () => {
  it("adds rep and keeps old rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "openeval-migrate-reps-"));
    const path = join(dir, "openeval.sqlite");
    const old = new Database(path);
    old.exec(`CREATE TABLE run_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, eval_id TEXT NOT NULL,
      model_id TEXT NOT NULL, passed INTEGER NOT NULL, reason_short TEXT NOT NULL,
      time_ms REAL NOT NULL, cost_usd REAL NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (run_id, eval_id, model_id))`);
    old.prepare(
      `INSERT INTO run_results (run_id, eval_id, model_id, passed, reason_short, time_ms, cost_usd, created_at)
       VALUES ('run_1', 'e1', 'm/a', 1, 'ok', 5, 0.1, 'now')`,
    ).run();
    old.close();

    const db = openDb(path);
    const rows = db.prepare(`SELECT rep, outcome, cost_source, passed FROM run_results`).all();
    assert.deepEqual(rows, [{ rep: 0, outcome: "scored", cost_source: "estimate", passed: 1 }]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("run_evals with candidates and reps", () => {
  let app: FastifyInstance;
  let dir: string;
  let projectId: string;
  let evalSetId: string;
  let keysRef: string;
  const calls: Array<{ model: string; systemPrompt?: string; settings?: ModelSettings }> = [];

  beforeEach(async () => {
    calls.length = 0;
    dir = mkdtempSync(join(tmpdir(), "openeval-candidates-"));
    const sqlitePath = join(dir, "openeval.sqlite");
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: {
        async chatCompletion(input) {
          calls.push({ model: input.model, systemPrompt: input.systemPrompt, settings: input.settings });
          return {
            content: GOOD_JSON,
            time_ms: 10,
            cost_usd: input.settings?.reasoning_effort === "low" ? 0.001 : 0.003,
            cost_source: "provider",
            prompt_tokens: 50,
            completion_tokens: 50,
          };
        },
      },
    });
    const proj = await app.inject({ method: "POST", url: "/v1/projects", headers: authHeaders(), payload: {} });
    projectId = (proj.json() as { project_id: string }).project_id;
    const db = new Database(sqlitePath);
    evalSetId = seedFiveTrustedEvals(db, projectId).evalSetId;
    keysRef = await storeCustomerKey(db, projectId);
    db.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs each candidate rep times with its settings and prompt", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        candidates: [
          { id: "m/a#low", model: "m/a", settings: { reasoning_effort: "low" }, system_prompt: "Be brief." },
          { id: "m/a", model: "m/a" },
        ],
        reps: 3,
        max_eval_spend_usd: 5,
        keys_ref: keysRef,
        idempotency_key: "cand-1",
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const { run_id: runId } = res.json() as { run_id: string };
    const report = await waitForRunComplete(app, projectId, runId);
    assert.equal(report.status, "succeeded");
    assert.equal(calls.length, 2 * 5 * 3);
    assert.ok(calls.some((c) => c.systemPrompt === "Be brief." && c.settings?.reasoning_effort === "low"));
    const models = report.models as Array<{ model_id: string; n_trials: number; cost_source: string }>;
    assert.equal(models.find((m) => m.model_id === "m/a#low")?.n_trials, 15);
    assert.equal(models[0]!.cost_source, "provider");

    const rec = await app.inject({
      method: "POST",
      url: "/v1/tools/recommend_models",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        run_id: runId,
        intent: "new_feature",
        idempotency_key: "cand-rec-1",
      },
    });
    assert.equal(rec.statusCode, 200, rec.body);
    const body = rec.json() as {
      named_model: { id: string; candidate?: { settings?: ModelSettings } };
      quality: { n_trials: number; pass_rate: number; pass_rate_ci95: [number, number] };
      cost_source: string;
    };
    assert.equal(body.named_model.id, "m/a#low");
    assert.equal(body.named_model.candidate?.settings?.reasoning_effort, "low");
    assert.equal(body.quality.n_trials, 15);
    assert.equal(body.quality.pass_rate, 1);
    assert.ok(body.quality.pass_rate_ci95[0] > 0.7);
    assert.equal(body.cost_source, "provider");
  });

  it("rejects models and candidates together", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        models: ["m/a"],
        candidates: [{ id: "m/a", model: "m/a" }],
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: "cand-both",
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it("rejects a candidate id that does not match its model", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        candidates: [{ id: "m/b#x", model: "m/a" }],
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: "cand-bad-id",
      },
    });
    assert.equal(res.statusCode, 400);
  });
});
