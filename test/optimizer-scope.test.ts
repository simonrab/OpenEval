import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { callToolViaHttp } from "../src/mcp/server.js";
import { buildApp } from "../src/server.js";
import { ensureEvalSplit } from "../src/splits.js";
import { TOOL_NAMES, type ToolName } from "../src/tools/schema.js";
import { ErrorCode } from "../src/tools/types.js";
import { addResults, insertRun, seedTrustedSet } from "./helpers/optimizer-fixtures.js";
import { authHeaders, storeCustomerKey, TEST_API_KEY } from "./helpers/run-fixtures.js";

type Body = Record<string, unknown>;

const ALLOWED: ToolName[] = [
  "run_evals",
  "get_eval_report",
  "get_training_failures",
  "get_verdict",
  "get_eval_inputs",
  "submit_outputs",
];

function bearer(key: string) {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

function injectFetch(app: FastifyInstance): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const res = await app.inject({
      method: "POST",
      url: url.pathname,
      headers: init?.headers as Record<string, string>,
      payload: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(res.body, { status: res.statusCode });
  };
}

describe("optimizer-scoped API key", () => {
  let dir: string;
  let app: FastifyInstance;
  let db: Database.Database;
  let projectId: string;
  let otherProjectId: string;
  let evalSetId: string;
  let train: string[];
  let holdout: string[];
  let titleOf: Map<string, string>;
  let runId: string;
  let keysRef: string;
  let optKey: string;

  async function newProject(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/v1/projects", headers: authHeaders(), payload: {} });
    return (res.json() as { project_id: string }).project_id;
  }

  async function mint(project: string, headers = authHeaders()) {
    return app.inject({
      method: "POST",
      url: "/v1/keys",
      headers,
      payload: { project_id: project, scope: "optimizer" },
    });
  }

  async function call(name: string, payload: Body, key = optKey) {
    const res = await app.inject({ method: "POST", url: `/v1/tools/${name}`, headers: bearer(key), payload });
    return { status: res.statusCode, body: res.json() as Body, text: res.body };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openeval-scope-"));
    const sqlitePath = join(dir, "openeval.sqlite");
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: {
        async chatCompletion() {
          return { content: "fine", time_ms: 1, cost_usd: 0 };
        },
      },
    });
    projectId = await newProject();
    otherProjectId = await newProject();
    db = openDb(sqlitePath);
    const seeded = seedTrustedSet(db, projectId, 20);
    evalSetId = seeded.evalSetId;
    titleOf = new Map(
      seeded.evalIds.map((id) => [
        id,
        (db.prepare(`SELECT title FROM evals WHERE id = ?`).get(id) as { title: string }).title,
      ]),
    );
    const split = ensureEvalSplit(db, evalSetId);
    train = [...split.splits].filter(([, s]) => s === "train").map(([id]) => id);
    holdout = [...split.splits].filter(([, s]) => s === "holdout").map(([id]) => id);
    runId = insertRun(db, { projectId, evalSetId, candidateIds: ["m/a", "m/b"] });
    for (const [i, id] of [...train, ...holdout].entries()) {
      addResults(db, runId, "m/a", id, i % 3 === 0 ? [false, false, false] : [true, false, true]);
      addResults(db, runId, "m/b", id, i % 4 === 0 ? ["error", "error", "error"] : [true, true, true]);
    }
    keysRef = await storeCustomerKey(db, projectId);
    const minted = await mint(projectId);
    assert.equal(minted.statusCode, 200, minted.body);
    optKey = (minted.json() as { api_key: string }).api_key;
  });

  afterEach(async () => {
    db.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("mints a key for one project and stores only its hash", async () => {
    const minted = await mint(projectId);
    const body = minted.json() as Body;
    assert.equal(body.scope, "optimizer");
    assert.equal(body.project_id, projectId);
    assert.match(String(body.api_key), /^oeo_/);
    const rows = db.prepare(`SELECT key_hash, project_id, scope FROM scoped_api_keys`).all() as Body[];
    assert.equal(rows.length, 2);
    assert.equal(JSON.stringify(rows).includes(String(body.api_key)), false);

    assert.equal((await mint("prj_missing")).statusCode, 404);
    const bad = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: authHeaders(),
      payload: { project_id: projectId, scope: "admin" },
    });
    assert.equal(bad.statusCode, 400);
  });

  it("does not let a scoped key mint keys or use other /v1 routes", async () => {
    const minted = await mint(projectId, bearer(optKey));
    assert.equal(minted.statusCode, 403);
    assert.equal((minted.json() as Body).code, ErrorCode.SCOPE_FORBIDDEN);
    for (const [method, url] of [
      ["GET", `/v1/projects/${projectId}`],
      ["POST", "/v1/projects"],
      ["GET", `/v1/keys/${keysRef}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: bearer(optKey), payload: method === "POST" ? {} : undefined });
      assert.equal(res.statusCode, 403, url);
    }
    const bad = await app.inject({ method: "GET", url: `/v1/projects/${projectId}`, headers: bearer("oeo_wrong") });
    assert.equal(bad.statusCode, 401);
  });

  it("allows only the optimizer tools", async () => {
    for (const name of TOOL_NAMES) {
      const res = await call(name, { project_id: projectId });
      if (ALLOWED.includes(name)) {
        assert.notEqual(res.status, 403, `${name} is forbidden: ${res.text}`);
        continue;
      }
      assert.equal(res.status, 403, `${name} is allowed`);
      assert.equal(res.body.code, ErrorCode.SCOPE_FORBIDDEN);
      assert.equal((res.body.next_action as Body).tool, null);
      assert.equal(res.body.retryable, false);
    }
  });

  it("does not let the optimizer configure or calibrate its own grader", async () => {
    const configure = await call("configure_judge", {
      project_id: projectId,
      eval_set_id: evalSetId,
      judge_model: "m/judge",
      idempotency_key: "judge-a",
    });
    assert.equal(configure.status, 403);
    assert.equal(configure.body.code, ErrorCode.SCOPE_FORBIDDEN);
    const calibrate = await call("calibrate_judge", {
      project_id: projectId,
      eval_set_id: evalSetId,
      keys_ref: keysRef,
      max_eval_spend_usd: 1,
      idempotency_key: "judge-b",
    });
    assert.equal(calibrate.status, 403);
    assert.equal(calibrate.body.code, ErrorCode.SCOPE_FORBIDDEN);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM judges`).get() as { n: number }).n, 0);
  });

  it("rejects a submit_outputs keys_ref from another project", async () => {
    const otherRef = await storeCustomerKey(db, otherProjectId);
    const res = await call("submit_outputs", {
      project_id: projectId,
      eval_set_id: evalSetId,
      candidate: { id: "harness#x" },
      outputs: [{ eval_id: train[0], output: "fine" }],
      keys_ref: otherRef,
      max_eval_spend_usd: 1,
      idempotency_key: "sub-other",
    });
    assert.equal(res.status, 403);
  });

  it("rejects calls for another project", async () => {
    const inputs = await call("get_eval_inputs", { project_id: otherProjectId, eval_set_id: evalSetId });
    assert.equal(inputs.status, 403);
    assert.equal(inputs.body.code, ErrorCode.SCOPE_FORBIDDEN);
    const report = await call("get_eval_report", { project_id: otherProjectId, run_id: runId });
    assert.equal(report.status, 403);
    const otherRef = await storeCustomerKey(db, otherProjectId);
    const run = await call("run_evals", {
      project_id: projectId,
      eval_set_id: evalSetId,
      candidates: [{ id: "m/a", model: "m/a" }],
      max_eval_spend_usd: 1,
      keys_ref: otherRef,
      idempotency_key: "idem-x",
    });
    assert.equal(run.status, 403);
  });

  it("allows run_evals only with candidates or models and never recheck", async () => {
    const base = {
      project_id: projectId,
      eval_set_id: evalSetId,
      max_eval_spend_usd: 1,
      keys_ref: keysRef,
    };
    const noModels = await call("run_evals", { ...base, idempotency_key: "a" });
    assert.equal(noModels.status, 403);
    const recheck = await call("run_evals", {
      ...base,
      intent: "recheck",
      named_model: { rec_id: "rec_1", model_id: "m/a" },
      models: ["m/a"],
      idempotency_key: "b",
    });
    assert.equal(recheck.status, 403);
    const ok = await call("run_evals", {
      ...base,
      candidates: [{ id: "m/a#v1", model: "m/a", system_prompt: "v1" }],
      idempotency_key: "c",
    });
    assert.equal(ok.status, 200, ok.text);
    const models = await call("run_evals", { ...base, models: ["m/a"], idempotency_key: "d" });
    assert.equal(models.status, 200, models.text);
  });

  it("redacts holdout evals from get_eval_report", async () => {
    const pages: Body[] = [];
    let cursor: string | null = null;
    do {
      const res = await call("get_eval_report", {
        project_id: projectId,
        run_id: runId,
        limit: 5,
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(res.status, 200, res.text);
      pages.push(res.body);
      cursor = res.body.next_cursor as string | null;
    } while (cursor);
    const text = JSON.stringify(pages);
    for (const id of holdout) {
      assert.equal(text.includes(id), false, `holdout id ${id} leaks`);
      assert.equal(text.includes(titleOf.get(id)!), false, `holdout title leaks`);
    }
    const first = pages[0]!;
    assert.equal(first.report_url, null);
    const items = pages.flatMap((p) => p.items as Array<{ eval_id: string }>);
    assert.deepEqual(items.map((i) => i.eval_id).sort(), [...train].sort());
    assert.ok((first.failing_eval_ids as string[]).every((id) => train.includes(id)));
    assert.ok((first.failing_eval_ids as string[]).length > 0);
    assert.ok((first.eval_ids_scored as string[]).every((id) => train.includes(id)));
    for (const m of first.models as Array<Record<string, string[]>>) {
      for (const key of ["failing_eval_ids", "flaky_eval_ids", "error_eval_ids"]) {
        assert.ok((m[key] ?? []).every((id) => train.includes(id)), key);
      }
    }
    const hidden = first.holdout_redacted as { n_evals: number; n_pass: number; n_fail: number };
    assert.equal(hidden.n_evals, holdout.length);
    assert.equal(hidden.n_pass + hidden.n_fail, holdout.length);
    assert.notEqual((first.next_action as Body).tool, "recommend_models");
  });

  it("keeps the full report for a full-scope key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/get_eval_report",
      headers: authHeaders(),
      payload: { project_id: projectId, run_id: runId, limit: 50 },
    });
    const body = res.json() as Body;
    assert.equal(typeof body.report_url, "string");
    assert.equal("holdout_redacted" in body, false);
    const ids = (body.items as Array<{ eval_id: string }>).map((i) => i.eval_id);
    assert.ok(holdout.every((id) => ids.includes(id)));
    assert.equal((body.next_action as Body).tool, "recommend_models");
  });

  it("works through the MCP HTTP client with OPENEVAL_KEY set to the scoped key", async () => {
    const config = { baseUrl: "http://test.local", apiKey: optKey, fetch: injectFetch(app) };
    const ok = await callToolViaHttp("get_eval_inputs", { project_id: projectId, eval_set_id: evalSetId }, config);
    assert.equal(ok.status, 200);
    const forbidden = await callToolViaHttp(
      "recommend_models",
      { project_id: projectId, eval_set_id: evalSetId, intent: "new_feature", idempotency_key: "k" },
      config,
    );
    assert.equal(forbidden.status, 403);
    assert.equal((forbidden.body as Body).code, ErrorCode.SCOPE_FORBIDDEN);
  });

  it("keeps working after a server restart", async () => {
    const sqlitePath = join(dir, "openeval.sqlite");
    await app.close();
    app = await buildApp({ sqlitePath, apiKey: TEST_API_KEY, baseUrl: "http://test.local" });
    const res = await call("get_eval_inputs", { project_id: projectId, eval_set_id: evalSetId });
    assert.equal(res.status, 200, res.text);
  });
});
