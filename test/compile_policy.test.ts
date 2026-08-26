import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { newEvalSetId, newJobId, newRecId, newRunId } from "../src/ids.js";
import { DEFAULT_MAX_WAIT_MS } from "../src/policy.js";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
import { compilePolicyOutputSchema } from "../src/tools/schema.js";
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
  maxWaitMs?: number | null;
  evalSetId?: string;
  recId?: string;
};

describe("compile_policy (R1)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let openRouterCalled = false;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-compile-policy-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    openRouterCalled = false;
    const openRouterClient = createMockOpenRouter(() => {
      openRouterCalled = true;
      throw new Error("compile_policy must not call OpenRouter");
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
    backups: string[];
  } {
    const recId = opts.recId ?? newRecId();
    const evalSetId = opts.evalSetId ?? newEvalSetId();
    const namedModelId =
      opts.namedModelId === undefined ? "openai/gpt-4.1-mini" : opts.namedModelId;
    const backups = opts.backups ?? ["openai/gpt-4.1-nano", "google/gemini-flash-1.5"];
    const approval = opts.approval === undefined ? "approved" : opts.approval;
    const jobId = newJobId();
    const runId = newRunId();
    const now = new Date().toISOString();
    const limits =
      opts.maxWaitMs === undefined
        ? null
        : opts.maxWaitMs === null
          ? null
          : JSON.stringify({ max_wait_ms: opts.maxWaitMs });

    const db = new Database(sqlitePath);
    try {
      db.prepare(
        `INSERT INTO jobs (id, project_id, description, limits, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(jobId, projectId, "JSON invoice job", limits, now);
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

    return { recId, evalSetId, namedModelId, backups };
  }

  async function compile(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/v1/tools/compile_policy",
      headers: authHeaders(),
      payload: body,
    });
  }

  async function getPolicy(id = projectId) {
    return app.inject({
      method: "GET",
      url: `/v1/runtime/policies/${id}`,
      headers: authHeaders(),
    });
  }

  function parseApproveUrl(url: string): { policyId: string; token: string } {
    const parsed = new URL(url);
    const policyId = parsed.searchParams.get("policy_id");
    const token = parsed.searchParams.get("token");
    assert.ok(policyId);
    assert.ok(token);
    return { policyId, token };
  }

  async function decideCompile(
    approveUrl: string,
    decision: "approved" | "rejected",
  ) {
    const { policyId, token } = parseApproveUrl(approveUrl);
    return app.inject({
      method: "POST",
      url: "/compile-approve",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: {
        policy_id: policyId,
        token,
        decision,
      },
    });
  }

  it("compiles an approved rec into a pol_ with approve_url and live_traffic_changed false", async () => {
    const seeded = seedRecommendation();
    const res = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-happy-1",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      policy_id: string;
      approve_url: string;
      live_traffic_changed: boolean;
      next_action: {
        tool: string | null;
        args: Record<string, unknown>;
        ask_human: string | null;
      };
    };
    assert.equal(compilePolicyOutputSchema.safeParse(body).success, true);
    assert.match(body.policy_id, /^pol_/);
    assert.equal(body.live_traffic_changed, false);
    assert.match(body.approve_url, /\/compile-approve/);
    assert.match(body.approve_url, /policy_id=/);
    assert.match(body.approve_url, /token=/);
    assert.equal(body.next_action.tool, null);
    assert.equal(body.next_action.ask_human, "open approve_url");
    assert.equal(body.next_action.args.approve_url, body.approve_url);
    assert.equal(openRouterCalled, false);

    const db = new Database(sqlitePath, { readonly: true });
    const row = db
      .prepare(`SELECT body_json FROM policies WHERE id = ?`)
      .get(body.policy_id) as { body_json: string };
    db.close();
    const stored = JSON.parse(row.body_json) as {
      primary: { model_id: string; timeout_ms: number };
      backups: Array<{ model_id: string; timeout_ms: number }>;
      rec_id: string;
      ste_id: string;
    };
    assert.equal(stored.primary.model_id, seeded.namedModelId);
    assert.equal(stored.primary.timeout_ms, DEFAULT_MAX_WAIT_MS);
    assert.deepEqual(
      stored.backups.map((b) => b.model_id),
      seeded.backups,
    );
    assert.equal(stored.rec_id, seeded.recId);
    assert.equal(stored.ste_id, seeded.evalSetId);
  });

  it("rejects an extra input field", async () => {
    const seeded = seedRecommendation();
    const res = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-extra",
      unexpected_field: true,
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal((body as { code: string }).code, ErrorCode.INVALID_INPUT);
    assert.ok((body as { next_action: unknown }).next_action);
  });

  it("rejects a missing idempotency_key", async () => {
    const seeded = seedRecommendation();
    const res = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal((body as { code: string }).code, ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
    assert.ok((body as { next_action: unknown }).next_action);
  });

  it("returns the same pol_ for the same idempotency_key", async () => {
    const seeded = seedRecommendation();
    const payload = {
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-idem-1",
    };
    const first = await compile(payload);
    const second = await compile(payload);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const a = first.json() as { policy_id: string };
    const b = second.json() as { policy_id: string };
    assert.equal(a.policy_id, b.policy_id);

    const db = new Database(sqlitePath, { readonly: true });
    const n = db.prepare(`SELECT COUNT(*) AS n FROM policies`).get() as { n: number };
    db.close();
    assert.equal(n.n, 1);
  });

  it("returns REC_NOT_APPROVED when the rec is rejected", async () => {
    const seeded = seedRecommendation({ approval: "rejected" });
    const res = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-rejected",
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string; next_action: unknown };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.REC_NOT_APPROVED);
    assert.ok(body.next_action);
  });

  it("returns REC_NOT_APPROVED when the rec has no approval", async () => {
    const seeded = seedRecommendation({ approval: null });
    const res = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-no-approval",
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string; next_action: unknown };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.REC_NOT_APPROVED);
    assert.ok(body.next_action);
  });

  it("returns REC_NOT_APPROVED when the rec is missing", async () => {
    const seeded = seedRecommendation();
    const res = await compile({
      project_id: projectId,
      recommendation_id: "rec_does_not_exist",
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-missing-rec",
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string; next_action: unknown };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.REC_NOT_APPROVED);
    assert.ok(body.next_action);
  });

  it("returns STE_MISMATCH when eval_set_id is not the rec eval set", async () => {
    const seeded = seedRecommendation();
    const res = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: "ste_other_set",
      idempotency_key: "compile-ste-mismatch",
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string; next_action: unknown };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.STE_MISMATCH);
    assert.ok(body.next_action);
  });

  it("returns REC_NOT_APPROVED when named_model is null and stores no pol_", async () => {
    const seeded = seedRecommendation({ namedModelId: null, backups: [] });
    const res = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-null-named",
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string; next_action: unknown };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.REC_NOT_APPROVED);
    assert.ok(body.next_action);

    const db = new Database(sqlitePath, { readonly: true });
    const n = db.prepare(`SELECT COUNT(*) AS n FROM policies`).get() as { n: number };
    db.close();
    assert.equal(n.n, 0);
  });

  it("returns PROJECT_NOT_FOUND for an unknown project", async () => {
    const res = await compile({
      project_id: "prj_missing",
      recommendation_id: "rec_x",
      eval_set_id: "ste_x",
      idempotency_key: "compile-no-project",
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { code: string; next_action: unknown };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.PROJECT_NOT_FOUND);
    assert.ok(body.next_action);
  });

  it("uses max_wait_ms from job limits on primary and backups", async () => {
    const seeded = seedRecommendation({ maxWaitMs: 5000 });
    const res = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-wait-limits",
    });
    assert.equal(res.statusCode, 200);
    const policyId = (res.json() as { policy_id: string }).policy_id;
    const db = new Database(sqlitePath, { readonly: true });
    const row = db
      .prepare(`SELECT body_json FROM policies WHERE id = ?`)
      .get(policyId) as { body_json: string };
    db.close();
    const stored = JSON.parse(row.body_json) as {
      primary: { timeout_ms: number };
      backups: Array<{ timeout_ms: number }>;
    };
    assert.equal(stored.primary.timeout_ms, 5000);
    for (const backup of stored.backups) {
      assert.equal(backup.timeout_ms, 5000);
    }
  });

  it("uses default 30000 when job limits omit max_wait_ms", async () => {
    const seeded = seedRecommendation({ maxWaitMs: null });
    const res = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-wait-default",
    });
    assert.equal(res.statusCode, 200);
    const policyId = (res.json() as { policy_id: string }).policy_id;
    const db = new Database(sqlitePath, { readonly: true });
    const row = db
      .prepare(`SELECT body_json FROM policies WHERE id = ?`)
      .get(policyId) as { body_json: string };
    db.close();
    const stored = JSON.parse(row.body_json) as {
      primary: { timeout_ms: number };
    };
    assert.equal(stored.primary.timeout_ms, 30000);
    assert.equal(DEFAULT_MAX_WAIT_MS, 30000);
  });

  it("GET is 404 before the first compile approve", async () => {
    const seeded = seedRecommendation();
    const compiled = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-before-approve",
    });
    assert.equal(compiled.statusCode, 200);

    const res = await getPolicy();
    assert.equal(res.statusCode, 404);
    const body = res.json() as { code: string };
    assert.equal(body.code, ErrorCode.NO_LAST_KNOWN_POLICY);
  });

  it("GET is 200 with this pol_ after the first compile approve", async () => {
    const seeded = seedRecommendation();
    const compiled = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-first-approve",
    });
    const body = compiled.json() as { policy_id: string; approve_url: string };
    const decided = await decideCompile(body.approve_url, "approved");
    assert.equal(decided.statusCode, 200);
    const screen = decided.json() as { live_traffic_changed: boolean; decision: string };
    assert.equal(screen.decision, "approved");
    assert.equal(screen.live_traffic_changed, false);

    const res = await getPolicy();
    assert.equal(res.statusCode, 200);
    const policy = res.json() as { policy_id: string; primary: { model_id: string } };
    assert.equal(policy.policy_id, body.policy_id);
    assert.equal(policy.primary.model_id, seeded.namedModelId);
  });

  it("GET stays 404 after reject of the first policy", async () => {
    const seeded = seedRecommendation();
    const compiled = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-reject-first",
    });
    const body = compiled.json() as { approve_url: string };
    const decided = await decideCompile(body.approve_url, "rejected");
    assert.equal(decided.statusCode, 200);

    const res = await getPolicy();
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { code: string }).code, ErrorCode.NO_LAST_KNOWN_POLICY);
  });

  it("second compile approve does not change GET last full", async () => {
    const first = seedRecommendation({
      namedModelId: "openai/gpt-4.1-mini",
      backups: ["openai/gpt-4.1-nano"],
    });
    const compiled1 = await compile({
      project_id: projectId,
      recommendation_id: first.recId,
      eval_set_id: first.evalSetId,
      idempotency_key: "compile-first-full",
    });
    const body1 = compiled1.json() as { policy_id: string; approve_url: string };
    await decideCompile(body1.approve_url, "approved");

    const second = seedRecommendation({
      namedModelId: "anthropic/claude-3-haiku",
      backups: [],
    });
    const compiled2 = await compile({
      project_id: projectId,
      recommendation_id: second.recId,
      eval_set_id: second.evalSetId,
      idempotency_key: "compile-second-draft",
    });
    const body2 = compiled2.json() as { policy_id: string; approve_url: string };
    assert.notEqual(body2.policy_id, body1.policy_id);
    const decided2 = await decideCompile(body2.approve_url, "approved");
    assert.equal(decided2.statusCode, 200);

    const res = await getPolicy();
    assert.equal(res.statusCode, 200);
    const policy = res.json() as { policy_id: string; primary: { model_id: string } };
    assert.equal(policy.policy_id, body1.policy_id);
    assert.equal(policy.primary.model_id, "openai/gpt-4.1-mini");
  });

  it("does not call OpenRouter", async () => {
    const seeded = seedRecommendation();
    await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-no-or",
    });
    assert.equal(openRouterCalled, false);
  });

  it("GET compile-approve HTML shows primary, backups, rec_, and ste_", async () => {
    const seeded = seedRecommendation();
    const compiled = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-html",
    });
    const body = compiled.json() as { approve_url: string };
    const { policyId, token } = parseApproveUrl(body.approve_url);
    const res = await app.inject({
      method: "GET",
      url: `/compile-approve?policy_id=${encodeURIComponent(policyId)}&token=${token}`,
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(res.body, /openai\/gpt-4\.1-mini/);
    assert.match(res.body, /openai\/gpt-4\.1-nano/);
    assert.match(res.body, new RegExp(seeded.recId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(res.body, new RegExp(seeded.evalSetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(res.body, /\bshould\b/);
    assert.doesNotMatch(res.body, /\bcould\b/);
    assert.doesNotMatch(res.body, /\bmight\b/);
    assert.doesNotMatch(res.body, /unit test/i);
  });

  it("does not serve an unsigned last-full pointer", async () => {
    const seeded = seedRecommendation();
    const compiled = await compile({
      project_id: projectId,
      recommendation_id: seeded.recId,
      eval_set_id: seeded.evalSetId,
      idempotency_key: "compile-unsigned-last-full",
    });
    const policyId = (compiled.json() as { policy_id: string }).policy_id;
    const db = new Database(sqlitePath);
    try {
      db.prepare(
        `UPDATE policies SET body_json = json_set(body_json, '$.sig', '') WHERE id = ?`,
      ).run(policyId);
      db.prepare(
        `INSERT INTO project_live_state (project_id, last_full_policy_id, draft_policy_id)
         VALUES (?, ?, NULL)
         ON CONFLICT(project_id) DO UPDATE SET last_full_policy_id = excluded.last_full_policy_id`,
      ).run(projectId, policyId);
    } finally {
      db.close();
    }

    const res = await getPolicy();
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { code: string }).code, ErrorCode.NO_LAST_KNOWN_POLICY);
  });
});
