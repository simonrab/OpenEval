import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { newRunId } from "../src/ids.js";
import type { OpenRouterClient } from "../src/runner/openrouter.js";
import { listRunResults } from "../src/runner/queue.js";
import { processRun } from "../src/runner/worker.js";
import {
  acquireEvalStart,
  createSpendGate,
  finishEvalSpend,
} from "../src/runner/spend.js";
import {
  seedFiveTrustedEvals,
  storeCustomerKey,
  TEST_API_KEY,
} from "./helpers/run-fixtures.js";

const GOOD_JSON =
  '{"line_items":[{"sku":"a","qty":1}],"total_cents":100}';

function createDelayedMockOpenRouter(
  delayMs: number,
  costUsd = 0.05,
): OpenRouterClient & { maxConcurrent: () => number } {
  let concurrent = 0;
  let peak = 0;
  return {
    maxConcurrent: () => peak,
    async chatCompletion({ model, prompt, apiKey }) {
      void model;
      void prompt;
      void apiKey;
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, delayMs));
      concurrent -= 1;
      return {
        content: GOOD_JSON,
        time_ms: delayMs,
        cost_usd: costUsd,
      };
    },
  };
}

function insertQueuedRun(
  db: Database.Database,
  input: {
    projectId: string;
    evalSetId: string;
    models: string[];
    maxEvalSpendUsd: number;
    keysRef: string;
    intent?: string;
    namedModel?: string;
  },
): string {
  const runId = newRunId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs
      (id, project_id, eval_set_id, eval_set_version, status, code, models,
       max_eval_spend_usd, keys_ref, intent, named_model, new_failures,
       spend_usd, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'running', NULL, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
  ).run(
    runId,
    input.projectId,
    input.evalSetId,
    JSON.stringify(input.models),
    input.maxEvalSpendUsd,
    input.keysRef,
    input.intent ?? "new_feature",
    input.namedModel ?? null,
    `worker-parallel-${runId}`,
    now,
    now,
  );
  return runId;
}

describe("worker parallel fan-out", () => {
  let dir: string;
  let sqlitePath: string;
  let db: Database.Database;
  let projectId: string;
  let evalSetId: string;
  let keysRef: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-worker-par-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    db = openDb(sqlitePath);
    projectId = "prj_worker_par";
    db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
      projectId,
      new Date().toISOString(),
    );
    const seeded = seedFiveTrustedEvals(db, projectId);
    evalSetId = seeded.evalSetId;
    keysRef = await storeCustomerKey(db, projectId);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs two models concurrently (wall time less than sequential sum)", async () => {
    const delayMs = 80;
    const openRouter = createDelayedMockOpenRouter(delayMs);
    const runId = insertQueuedRun(db, {
      projectId,
      evalSetId,
      models: ["model/a", "model/b"],
      maxEvalSpendUsd: 5,
      keysRef,
    });

    const started = Date.now();
    await processRun(
      { db, apiKey: TEST_API_KEY, openRouter },
      runId,
    );
    const elapsed = Date.now() - started;

    const sequentialMs = delayMs * 5 * 2;
    assert.ok(
      elapsed < sequentialMs * 0.7,
      `expected parallel wall time < ${sequentialMs * 0.7}ms, got ${elapsed}ms`,
    );
    assert.ok(openRouter.maxConcurrent() >= 2, "expected overlapping model calls");
    const results = listRunResults(db, runId);
    assert.equal(results.length, 10);
  });

  it("spend gate prevents 8x overshoot with parallel models", async () => {
    const openRouter = createDelayedMockOpenRouter(5, 0.05);
    const runId = insertQueuedRun(db, {
      projectId,
      evalSetId,
      models: ["model/a", "model/b", "model/c"],
      maxEvalSpendUsd: 0.01,
      keysRef,
    });

    await processRun(
      { db, apiKey: TEST_API_KEY, openRouter },
      runId,
    );

    const run = db
      .prepare("SELECT status, spend_usd FROM runs WHERE id = ?")
      .get(runId) as { status: string; spend_usd: number };
    assert.equal(run.status, "partial");
    assert.ok(run.spend_usd <= 0.06, `spend ${run.spend_usd} overshot cap by >1 call`);
    const results = listRunResults(db, runId);
    assert.ok(results.length >= 1);
    assert.ok(results.length < 15, "cap should stop most eval starts");
  });

  it("recheck run row scores only the named model", async () => {
    const namedModelId = "openai/gpt-4o-mini";
    const runId = insertQueuedRun(db, {
      projectId,
      evalSetId,
      models: [namedModelId],
      maxEvalSpendUsd: 1,
      keysRef,
      intent: "recheck",
      namedModel: JSON.stringify({
        rec_id: "rec_x",
        model_id: namedModelId,
      }),
    });

    await processRun(
      { db, apiKey: TEST_API_KEY, openRouter: createDelayedMockOpenRouter(5, 0.05) },
      runId,
    );

    const stored = db
      .prepare("SELECT models, status FROM runs WHERE id = ?")
      .get(runId) as { models: string; status: string };
    const models = JSON.parse(stored.models) as string[];
    assert.deepEqual(models, [namedModelId]);
    assert.equal(stored.status, "succeeded");

    const results = listRunResults(db, runId);
    const modelIds = new Set(results.map((r) => r.model_id));
    assert.deepEqual([...modelIds], [namedModelId]);
    assert.equal(results.length, 5);
  });
});

describe("spend gate parallel unit", () => {
  it("allows only one projected overshoot when near cap", async () => {
    const gate = createSpendGate(0.01);
    gate.lastCost = 0.05;

    const first = await acquireEvalStart(gate);
    assert.equal(first, true);

    const second = await acquireEvalStart(gate);
    assert.equal(second, false);

    await finishEvalSpend(gate, 0.05);
    assert.equal(gate.exceeded, true);
    assert.equal(gate.inFlight, 0);
  });

  it("allows multiple parallel starts when far below cap", async () => {
    const gate = createSpendGate(1);
    gate.lastCost = 0.05;

    const starts: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      starts.push(await acquireEvalStart(gate));
    }
    assert.deepEqual(starts, [true, true, true, true, true]);
    assert.equal(gate.inFlight, 5);

    for (let i = 0; i < 5; i++) {
      await finishEvalSpend(gate, 0.05);
    }
    assert.equal(gate.exceeded, false);
    assert.equal(gate.spent, 0.25);
  });
});
