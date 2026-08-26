import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { newEvalSetId, newJobId, newRecId, newRunId } from "../src/ids.js";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
import { proposeRolloutOutputSchema } from "../src/tools/schema.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";

const apiKey = "test-key-not-a-secret";

function authHeaders(key = apiKey): {
  authorization: string;
  "content-type": string;
} {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

type SeedOpts = {
  namedModelId?: string | null;
  backups?: string[];
  approval?: "approved" | "rejected" | null;
};

type RuntimeGet = {
  last_full?: { policy_id: string; primary: { model_id: string }; sig?: string };
  canary?: { policy_id: string; primary: { model_id: string }; sig?: string } | null;
  canary_percent?: unknown;
  policy_id?: string;
};

describe("propose_rollout (R5, R6)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let openRouterCalled = false;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-propose-rollout-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    openRouterCalled = false;
    const openRouterClient = createMockOpenRouter(() => {
      openRouterCalled = true;
      throw new Error("propose_rollout must not call OpenRouter");
    });
    const listModels = openRouterClient.listModels.bind(openRouterClient);
    const chatCompletion = openRouterClient.chatCompletion.bind(openRouterClient);
    app = await buildApp({
      sqlitePath,
      apiKey,
      baseUrl: "http://test.local",
      openRouterClient: {
        async chatCompletion(args) {
          openRouterCalled = true;
          return chatCompletion(args);
        },
        async listModels(key) {
          openRouterCalled = true;
          return listModels(key);
        },
      },
    });

    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeaders(),
      payload: {},
    });
    assert.equal(proj.statusCode, 200);
    projectId = (proj.json() as { project_id: string }).project_id;
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedRecommendation(opts: SeedOpts = {}): {
    recId: string;
    evalSetId: string;
    namedModelId: string | null;
  } {
    const recId = newRecId();
    const evalSetId = newEvalSetId();
    const namedModelId =
      opts.namedModelId === undefined ? "openai/gpt-4.1-mini" : opts.namedModelId;
    const backups = opts.backups ?? ["openai/gpt-4.1-nano"];
    const approval = opts.approval === undefined ? "approved" : opts.approval;
    const jobId = newJobId();
    const runId = newRunId();
    const now = new Date().toISOString();

    const db = new Database(sqlitePath);
    try {
      db.prepare(
        `INSERT INTO jobs (id, project_id, description, limits, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(jobId, projectId, "JSON invoice job", null, now);
      db.prepare(
        `INSERT INTO eval_sets
          (id, project_id, job_id, version, previous_eval_set_id, frozen_at, created_at)
         VALUES (?, ?, ?, 1, NULL, ?, ?)`,
      ).run(evalSetId, projectId, jobId, now, now);
      db.prepare(
        `INSERT INTO runs
          (id, project_id, eval_set_id, eval_set_version, status, code, models,
           max_eval_spend_usd, keys_ref, intent, named_model, new_failures,
           spend_usd, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'succeeded', NULL, '[]', 5, NULL, 'new_feature', NULL, NULL, 0, ?, ?, ?)`,
      ).run(runId, projectId, evalSetId, `run-${recId}`, now, now);
      db.prepare(
        `INSERT INTO recommendations
          (id, project_id, eval_set_id, run_id, intent, named_model_id,
           backup_model_ids, quality_json, time_json, cost_usd, failing_eval_ids, created_at)
         VALUES (?, ?, ?, ?, 'new_feature', ?, ?, '{"n_pass":5,"n_fail":0}',
                 '{"p50":100,"p95":200}', 0.1, '[]', ?)`,
      ).run(recId, projectId, evalSetId, runId, namedModelId, JSON.stringify(backups), now);
      if (approval) {
        db.prepare(
          `INSERT INTO named_model_approvals (recommendation_id, decision, decided_at)
           VALUES (?, ?, ?)`,
        ).run(recId, approval, now);
      }
    } finally {
      db.close();
    }

    return { recId, evalSetId, namedModelId };
  }

  async function compile(recId: string, evalSetId: string, key: string) {
    return app.inject({
      method: "POST",
      url: "/v1/tools/compile_policy",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        recommendation_id: recId,
        eval_set_id: evalSetId,
        idempotency_key: key,
      },
    });
  }

  async function propose(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/v1/tools/propose_rollout",
      headers: authHeaders(),
      payload: body,
    });
  }

  async function getPolicy() {
    return app.inject({
      method: "GET",
      url: `/v1/runtime/policies/${projectId}`,
      headers: authHeaders(),
    });
  }

  function parseApproveUrl(url: string): { rolloutId: string; token: string } {
    const parsed = new URL(url);
    const rolloutId = parsed.searchParams.get("rollout_id");
    const token = parsed.searchParams.get("token");
    assert.ok(rolloutId);
    assert.ok(token);
    return { rolloutId, token };
  }

  async function decideCompile(approveUrl: string, decision: "approved" | "rejected") {
    const parsed = new URL(approveUrl);
    return app.inject({
      method: "POST",
      url: "/compile-approve",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: {
        policy_id: parsed.searchParams.get("policy_id"),
        token: parsed.searchParams.get("token"),
        decision,
      },
    });
  }

  async function decideRollout(
    approveUrl: string,
    decision: "approved" | "rejected" | "rollback",
  ) {
    const { rolloutId, token } = parseApproveUrl(approveUrl);
    return app.inject({
      method: "POST",
      url: "/rollout-approve",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: {
        rollout_id: rolloutId,
        token,
        decision,
      },
    });
  }

  async function seedLastFullAndDraft(): Promise<{
    lastFullId: string;
    draftId: string;
  }> {
    const first = seedRecommendation({
      namedModelId: "openai/gpt-4.1-mini",
      backups: ["openai/gpt-4.1-nano"],
    });
    const compiled1 = await compile(first.recId, first.evalSetId, "compile-last-full");
    assert.equal(compiled1.statusCode, 200);
    const body1 = compiled1.json() as { policy_id: string; approve_url: string };
    await decideCompile(body1.approve_url, "approved");

    const second = seedRecommendation({
      namedModelId: "anthropic/claude-3-haiku",
      backups: [],
    });
    const compiled2 = await compile(second.recId, second.evalSetId, "compile-draft");
    assert.equal(compiled2.statusCode, 200);
    const body2 = compiled2.json() as { policy_id: string; approve_url: string };
    await decideCompile(body2.approve_url, "approved");
    return { lastFullId: body1.policy_id, draftId: body2.policy_id };
  }

  async function compileApprovedDraft(
    namedModelId: string,
    compileKey: string,
  ): Promise<string> {
    const next = seedRecommendation({
      namedModelId,
      backups: [],
    });
    const compiled = await compile(next.recId, next.evalSetId, compileKey);
    assert.equal(compiled.statusCode, 200);
    const body = compiled.json() as { policy_id: string; approve_url: string };
    await decideCompile(body.approve_url, "approved");
    return body.policy_id;
  }

  it("propose canary returns approve_url and live_traffic_changed false; GET stays last full", async () => {
    const seeded = await seedLastFullAndDraft();
    const res = await propose({
      project_id: projectId,
      intent: "canary",
      idempotency_key: "rollout-canary-1",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      approve_url: string;
      live_traffic_changed: boolean;
      next_action: {
        tool: string | null;
        args: Record<string, unknown>;
        ask_human: string | null;
      };
    };
    assert.equal(proposeRolloutOutputSchema.safeParse(body).success, true);
    assert.equal(body.live_traffic_changed, false);
    assert.match(body.approve_url, /\/rollout-approve/);
    assert.match(body.approve_url, /rollout_id=/);
    assert.match(body.approve_url, /token=/);
    assert.equal(body.next_action.tool, null);
    assert.equal(body.next_action.ask_human, "open approve_url");
    assert.equal(body.next_action.args.approve_url, body.approve_url);
    assert.equal(openRouterCalled, false);

    const get = await getPolicy();
    assert.equal(get.statusCode, 200);
    const doc = get.json() as RuntimeGet;
    assert.equal(doc.last_full?.policy_id, seeded.lastFullId);
    assert.equal(doc.canary, null);
    assert.equal(doc.canary_percent, 0);
    assert.notEqual(doc.policy_id, seeded.lastFullId);
  });

  it("rejects an extra JSON field", async () => {
    await seedLastFullAndDraft();
    const res = await propose({
      project_id: projectId,
      intent: "canary",
      idempotency_key: "rollout-extra",
      unexpected_field: true,
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal((body as { code: string }).code, ErrorCode.INVALID_INPUT);
  });

  it("rejects a missing idempotency_key", async () => {
    await seedLastFullAndDraft();
    const res = await propose({
      project_id: projectId,
      intent: "canary",
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal((body as { code: string }).code, ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
  });

  it("returns the same approve_url for the same idempotency_key", async () => {
    await seedLastFullAndDraft();
    const payload = {
      project_id: projectId,
      intent: "canary" as const,
      idempotency_key: "rollout-idem-1",
    };
    const first = await propose(payload);
    const second = await propose(payload);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const a = first.json() as { approve_url: string };
    const b = second.json() as { approve_url: string };
    assert.equal(a.approve_url, b.approve_url);
  });

  it("CI / propose does not change GET last full or canary", async () => {
    const seeded = await seedLastFullAndDraft();
    const before = await getPolicy();
    const beforeDoc = before.json() as RuntimeGet;
    const res = await propose({
      project_id: projectId,
      intent: "canary",
      idempotency_key: "rollout-ci-no-apply",
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { live_traffic_changed: boolean }).live_traffic_changed, false);

    const after = await getPolicy();
    const afterDoc = after.json() as RuntimeGet;
    assert.equal(afterDoc.last_full?.policy_id, seeded.lastFullId);
    assert.equal(afterDoc.last_full?.policy_id, beforeDoc.last_full?.policy_id);
    assert.equal(afterDoc.canary, null);
    assert.equal(afterDoc.canary_percent, 0);
  });

  it("after canary approve, GET has last full and canary at integer 5", async () => {
    const seeded = await seedLastFullAndDraft();
    const proposed = await propose({
      project_id: projectId,
      intent: "canary",
      idempotency_key: "rollout-canary-approve",
    });
    const { approve_url: approveUrl } = proposed.json() as { approve_url: string };
    const decided = await decideRollout(approveUrl, "approved");
    assert.equal(decided.statusCode, 200);
    const screen = decided.json() as { live_traffic_changed: boolean; decision: string };
    assert.equal(screen.decision, "approved");
    assert.equal(screen.live_traffic_changed, false);

    const get = await getPolicy();
    assert.equal(get.statusCode, 200);
    const doc = get.json() as RuntimeGet;
    assert.equal(doc.last_full?.policy_id, seeded.lastFullId);
    assert.equal(doc.canary?.policy_id, seeded.draftId);
    assert.equal(doc.canary_percent, 5);
    assert.equal(typeof doc.canary_percent, "number");
    assert.notEqual(doc.canary_percent, 50);
    assert.match(String(doc.last_full?.sig), /^hmac-sha256:/);
    assert.match(String(doc.canary?.sig), /^hmac-sha256:/);
  });

  it("reject canary keeps last full at 100 percent; canary stays off", async () => {
    const seeded = await seedLastFullAndDraft();
    const proposed = await propose({
      project_id: projectId,
      intent: "canary",
      idempotency_key: "rollout-canary-reject",
    });
    const { approve_url: approveUrl } = proposed.json() as { approve_url: string };
    const decided = await decideRollout(approveUrl, "rejected");
    assert.equal(decided.statusCode, 200);

    const get = await getPolicy();
    const doc = get.json() as RuntimeGet;
    assert.equal(doc.last_full?.policy_id, seeded.lastFullId);
    assert.equal(doc.canary, null);
    assert.equal(doc.canary_percent, 0);
  });

  it("propose full without canary returns CANARY_NOT_ACTIVE", async () => {
    await seedLastFullAndDraft();
    const res = await propose({
      project_id: projectId,
      intent: "full",
      idempotency_key: "rollout-full-no-canary",
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as {
      code: string;
      message: string;
      next_action: { tool: string | null; args: Record<string, unknown> };
    };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.CANARY_NOT_ACTIVE);
    assert.equal(body.next_action.tool, "propose_rollout");
    assert.equal(body.next_action.args.intent, "canary");
    assert.doesNotMatch(body.message, /\bshould\b/);
    assert.doesNotMatch(body.message, /\bcould\b/);
    assert.doesNotMatch(body.message, /\bmight\b/);
  });

  it("full approve makes the canary policy last full and turns canary off", async () => {
    const seeded = await seedLastFullAndDraft();
    const canary = await propose({
      project_id: projectId,
      intent: "canary",
      idempotency_key: "rollout-then-full-canary",
    });
    await decideRollout((canary.json() as { approve_url: string }).approve_url, "approved");

    const full = await propose({
      project_id: projectId,
      intent: "full",
      idempotency_key: "rollout-then-full",
    });
    assert.equal(full.statusCode, 200);
    assert.equal((full.json() as { live_traffic_changed: boolean }).live_traffic_changed, false);

    const beforeApprove = await getPolicy();
    assert.equal((beforeApprove.json() as RuntimeGet).last_full?.policy_id, seeded.lastFullId);

    await decideRollout((full.json() as { approve_url: string }).approve_url, "approved");
    const get = await getPolicy();
    const doc = get.json() as RuntimeGet;
    assert.equal(doc.last_full?.policy_id, seeded.draftId);
    assert.equal(doc.last_full?.primary.model_id, "anthropic/claude-3-haiku");
    assert.equal(doc.canary, null);
    assert.equal(doc.canary_percent, 0);
  });

  it("stale full approval cannot promote a newer canary", async () => {
    const seeded = await seedLastFullAndDraft();
    const firstCanary = await propose({
      project_id: projectId,
      intent: "canary",
      idempotency_key: "rollout-stale-first-canary",
    });
    await decideRollout(
      (firstCanary.json() as { approve_url: string }).approve_url,
      "approved",
    );
    const staleFull = await propose({
      project_id: projectId,
      intent: "full",
      idempotency_key: "rollout-stale-full",
    });
    const staleFullUrl = (staleFull.json() as { approve_url: string }).approve_url;

    const newerPolicyId = await compileApprovedDraft(
      "meta/llama-3.3-70b-instruct",
      "compile-newer-draft",
    );
    const newerCanary = await propose({
      project_id: projectId,
      intent: "canary",
      idempotency_key: "rollout-stale-newer-canary",
    });
    await decideRollout(
      (newerCanary.json() as { approve_url: string }).approve_url,
      "approved",
    );

    const staleDecision = await decideRollout(staleFullUrl, "approved");
    assert.equal(staleDecision.statusCode, 200);
    assert.equal((staleDecision.json() as { decision: string }).decision, "rejected");

    const get = await getPolicy();
    const doc = get.json() as RuntimeGet;
    assert.equal(doc.last_full?.policy_id, seeded.lastFullId);
    assert.equal(doc.canary?.policy_id, newerPolicyId);
    assert.equal(doc.canary_percent, 5);
  });

  it("rollback approve restores last full, does not run evals", async () => {
    const seeded = await seedLastFullAndDraft();
    const canary = await propose({
      project_id: projectId,
      intent: "canary",
      idempotency_key: "rollout-then-rollback-canary",
    });
    await decideRollout((canary.json() as { approve_url: string }).approve_url, "approved");
    const full = await propose({
      project_id: projectId,
      intent: "full",
      idempotency_key: "rollout-then-rollback-full",
    });
    await decideRollout((full.json() as { approve_url: string }).approve_url, "approved");

    openRouterCalled = false;
    const rollback = await propose({
      project_id: projectId,
      intent: "rollback",
      idempotency_key: "rollout-rollback",
    });
    assert.equal(rollback.statusCode, 200);
    assert.equal((rollback.json() as { live_traffic_changed: boolean }).live_traffic_changed, false);
    await decideRollout((rollback.json() as { approve_url: string }).approve_url, "approved");
    assert.equal(openRouterCalled, false);

    const get = await getPolicy();
    const doc = get.json() as RuntimeGet;
    assert.equal(doc.last_full?.policy_id, seeded.lastFullId);
    assert.equal(doc.last_full?.primary.model_id, "openai/gpt-4.1-mini");
    assert.equal(doc.canary, null);
    assert.equal(doc.canary_percent, 0);
  });

  it("GET rollout-approve HTML shows old pol, new pol, intent, and splits", async () => {
    const seeded = await seedLastFullAndDraft();
    const proposed = await propose({
      project_id: projectId,
      intent: "canary",
      idempotency_key: "rollout-html",
    });
    const { approve_url: approveUrl } = proposed.json() as { approve_url: string };
    const { rolloutId, token } = parseApproveUrl(approveUrl);
    const res = await app.inject({
      method: "GET",
      url: `/rollout-approve?rollout_id=${encodeURIComponent(rolloutId)}&token=${token}`,
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(res.body, new RegExp(seeded.lastFullId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(res.body, new RegExp(seeded.draftId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(res.body, /canary 5 percent/i);
    assert.match(res.body, /Intended split/);
    assert.match(res.body, /Observed split/);
    assert.match(res.body, /Fallback rate/);
    assert.match(res.body, /Rollback target/);
    assert.doesNotMatch(res.body, /\bshould\b/);
    assert.doesNotMatch(res.body, /\bcould\b/);
    assert.doesNotMatch(res.body, /\bmight\b/);
    assert.doesNotMatch(res.body, /unit test/i);
    assert.doesNotMatch(res.body, /<table/i);
  });

  it("ALTER adds canary columns on an existing project_live_state table", async () => {
    const db = new Database(sqlitePath);
    try {
      db.exec(`DROP TABLE IF EXISTS project_live_state`);
      db.exec(`
        CREATE TABLE project_live_state (
          project_id TEXT PRIMARY KEY,
          last_full_policy_id TEXT,
          draft_policy_id TEXT
        )
      `);
    } finally {
      db.close();
    }
    await app.close();
    app = await buildApp({
      sqlitePath,
      apiKey,
      baseUrl: "http://test.local",
      openRouterClient: createMockOpenRouter(() => {
        throw new Error("migrate must not call OpenRouter");
      }),
    });
    const check = new Database(sqlitePath, { readonly: true });
    try {
      const cols = check.pragma("table_info(project_live_state)") as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      assert.ok(names.includes("canary_policy_id"));
      assert.ok(names.includes("canary_percent"));
      assert.ok(names.includes("rollback_target_policy_id"));
    } finally {
      check.close();
    }
  });
});
