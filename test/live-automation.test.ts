import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import {
  newRecId,
  newRunId,
  newPolicyId,
  newSampleId,
} from "../src/ids.js";
import {
  promoteToLastFullIfNone,
  putPolicy,
  recordPolicyDecision,
  upsertDraftPolicy,
  type UnsignedPolicy,
} from "../src/policy.js";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
import { seedFiveTrustedEvals } from "./helpers/run-fixtures.js";

const apiKey = "test-key-not-a-secret";
const lastFullModel = "openai/gpt-4.1-mini";
const draftModel = "anthropic/claude-3-haiku";

function authHeaders(): {
  authorization: string;
  "content-type": string;
} {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

type RuntimeGet = {
  last_full?: { policy_id: string; primary: { model_id: string } };
  canary?: { policy_id: string; primary: { model_id: string } } | null;
  canary_percent?: number;
};

type CycleBody = {
  cycle_id: string | null;
  status: "succeeded" | "blocked";
  automation_mode: "manual" | "guarded";
  pending_action: string | null;
  blocked_reason: string | null;
  decision_ids: string[];
  audit_ids: string[];
  live_traffic_changed: boolean;
};

describe("Guarded Autopilot V2", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-v2-automation-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await buildApp({
      sqlitePath,
      apiKey,
      baseUrl: "http://test.local",
      openRouterClient: createMockOpenRouter(() => {
        throw new Error("automation tests must not call OpenRouter");
      }),
    });
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeaders(),
      payload: {},
    });
    assert.equal(project.statusCode, 200);
    projectId = (project.json() as { project_id: string }).project_id;
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function policy(
    modelId: string,
    recId: string,
    evalSetId: string,
    previousPolicyId: string | null,
  ): UnsignedPolicy {
    return {
      policy_id: newPolicyId(),
      version: previousPolicyId ? 2 : 1,
      previous_policy_id: previousPolicyId,
      project_id: projectId,
      rec_id: recId,
      ste_id: evalSetId,
      compiled_at: new Date().toISOString(),
      primary: { model_id: modelId, timeout_ms: 2500 },
      backups: [],
      canary: null,
    };
  }

  function insertRecommendation(
    db: Database.Database,
    evalSetId: string,
    recId: string,
    modelId: string,
    failingEvalIds: string[] = [],
  ): void {
    const runId = newRunId();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs
        (id, project_id, eval_set_id, eval_set_version, status, code, models,
         max_eval_spend_usd, keys_ref, intent, named_model, new_failures,
         spend_usd, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'succeeded', NULL, '[]', 5, NULL, 'new_feature',
               NULL, NULL, 0, ?, ?, ?)`,
    ).run(runId, projectId, evalSetId, `run-${recId}`, now, now);
    const nFail = failingEvalIds.length;
    db.prepare(
      `INSERT INTO recommendations
        (id, project_id, eval_set_id, run_id, intent, named_model_id,
         backup_model_ids, quality_json, time_json, cost_usd, failing_eval_ids,
         created_at)
       VALUES (?, ?, ?, ?, 'new_feature', ?, '[]', ?, '{"p50":100,"p95":200}',
               0.1, ?, ?)`,
    ).run(
      recId,
      projectId,
      evalSetId,
      runId,
      modelId,
      JSON.stringify({ n_pass: 5 - nFail, n_fail: nFail }),
      JSON.stringify(failingEvalIds),
      now,
    );
  }

  function seedLastFullAndDraft(
    opts: { failingEvalIds?: string[]; modelId?: string } = {},
  ): { lastFullId: string; draftId: string } {
    const db = openDb(sqlitePath);
    try {
      const seeded = seedFiveTrustedEvals(db, projectId);
      const lastRecId = newRecId();
      const draftRecId = newRecId();
      insertRecommendation(db, seeded.evalSetId, lastRecId, lastFullModel);
      insertRecommendation(
        db,
        seeded.evalSetId,
        draftRecId,
        opts.modelId ?? draftModel,
        opts.failingEvalIds ?? [],
      );
      const last = putPolicy(
        db,
        apiKey,
        policy(lastFullModel, lastRecId, seeded.evalSetId, null),
      );
      assert.equal(
        promoteToLastFullIfNone(db, apiKey, projectId, last.policy_id),
        true,
      );
      const draft = putPolicy(
        db,
        apiKey,
        policy(opts.modelId ?? draftModel, draftRecId, seeded.evalSetId, last.policy_id),
      );
      upsertDraftPolicy(db, projectId, draft.policy_id);
      recordPolicyDecision(db, draft.policy_id, "approved");
      return { lastFullId: last.policy_id, draftId: draft.policy_id };
    } finally {
      db.close();
    }
  }

  async function configure(
    guardRules: Record<string, unknown>,
    key = "cfg-1",
  ) {
    return app.inject({
      method: "POST",
      url: "/v1/tools/configure_live_automation",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        mode: "guarded",
        guard_rules: guardRules,
        approved_by: "per_admin",
        idempotency_key: key,
      },
    });
  }

  async function runCycle(key: string): Promise<CycleBody> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_live_decision_cycle",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        idempotency_key: key,
      },
    });
    assert.equal(res.statusCode, 200);
    return res.json() as CycleBody;
  }

  async function getPolicy(): Promise<RuntimeGet> {
    const res = await app.inject({
      method: "GET",
      url: `/v1/runtime/policies/${projectId}`,
      headers: authHeaders(),
    });
    assert.equal(res.statusCode, 200);
    return res.json() as RuntimeGet;
  }

  async function postStats(fallbackCount: number, requestCount: number): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/runtime/stats",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        hashed_request_count: requestCount,
        canary_request_count: requestCount,
        fallback_count: fallbackCount,
        request_count: requestCount,
        pii_blocked_count: 0,
      },
    });
    assert.equal(res.statusCode, 200);
  }

  async function postSample(policyId: string, why = "app_reported"): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/runtime/samples",
      headers: authHeaders(),
      payload: {
        sample_id: newSampleId(),
        project_id: projectId,
        policy_id: policyId,
        model_id: draftModel,
        why,
        input_redacted: "Name the total.",
        output_redacted: "bad json",
        captured_at: new Date().toISOString(),
      },
    });
    assert.equal(res.statusCode, 200);
  }

  it("manual mode never changes live policy", async () => {
    const seeded = seedLastFullAndDraft();
    const cycle = await runCycle("manual-cycle");
    assert.equal(cycle.status, "blocked");
    assert.equal(cycle.blocked_reason, "manual_mode");
    assert.equal(cycle.live_traffic_changed, false);
    const doc = await getPolicy();
    assert.equal(doc.last_full?.policy_id, seeded.lastFullId);
    assert.equal(doc.canary, null);
  });

  it("guarded mode publishes canary inside approved model limits", async () => {
    const seeded = seedLastFullAndDraft();
    const configured = await configure(
      {
        auto_canary: true,
        allowed_models: [draftModel],
        min_eval_pass_rate: 1,
      },
      "cfg-canary",
    );
    assert.equal(configured.statusCode, 200);
    const cycle = await runCycle("cycle-canary");
    assert.equal(cycle.status, "succeeded");
    assert.equal(cycle.pending_action, "auto_canary");
    assert.equal(cycle.decision_ids[0], seeded.draftId);
    const doc = await getPolicy();
    assert.equal(doc.canary?.policy_id, seeded.draftId);
    assert.equal(doc.canary_percent, 5);
  });

  it("failed trusted eval blocks canary", async () => {
    seedLastFullAndDraft({ failingEvalIds: ["cas_failed"] });
    await configure(
      {
        auto_canary: true,
        allowed_models: [draftModel],
        min_eval_pass_rate: 1,
      },
      "cfg-failed-eval",
    );
    const cycle = await runCycle("cycle-failed-eval");
    assert.equal(cycle.status, "blocked");
    assert.equal(cycle.blocked_reason, "failed_trusted_eval");
    const doc = await getPolicy();
    assert.equal(doc.canary, null);
  });

  it("P0 live miss blocks full rollout", async () => {
    const seeded = seedLastFullAndDraft();
    await configure(
      {
        auto_canary: true,
        auto_full: true,
        allowed_models: [draftModel],
        min_canary_requests: 1,
      },
      "cfg-p0",
    );
    assert.equal((await runCycle("cycle-p0-canary")).pending_action, "auto_canary");
    await postStats(0, 5);
    await postSample(seeded.draftId, "app_reported");
    const cycle = await runCycle("cycle-p0-full");
    assert.equal(cycle.status, "blocked");
    assert.equal(cycle.blocked_reason, "p0_live_miss");
    const doc = await getPolicy();
    assert.equal(doc.last_full?.policy_id, seeded.lastFullId);
    assert.equal(doc.canary?.policy_id, seeded.draftId);
  });

  it("auto rollback runs before auto full", async () => {
    const seeded = seedLastFullAndDraft();
    await configure(
      {
        auto_canary: true,
        auto_full: true,
        auto_rollback: true,
        allowed_models: [draftModel],
        max_fallback_rate: 0.1,
        min_canary_requests: 1,
      },
      "cfg-rollback",
    );
    assert.equal((await runCycle("cycle-rollback-canary")).pending_action, "auto_canary");
    await postStats(2, 10);
    const cycle = await runCycle("cycle-rollback");
    assert.equal(cycle.status, "succeeded");
    assert.equal(cycle.pending_action, "auto_rollback");
    const doc = await getPolicy();
    assert.equal(doc.last_full?.policy_id, seeded.lastFullId);
    assert.equal(doc.canary, null);
  });

  it("sample flood is quarantined", async () => {
    const seeded = seedLastFullAndDraft();
    await postSample(seeded.lastFullId, "vendor_error");
    await postSample(seeded.lastFullId, "vendor_error");
    await configure(
      {
        sample_flood_limit: 1,
      },
      "cfg-flood",
    );
    const cycle = await runCycle("cycle-flood");
    assert.equal(cycle.status, "blocked");
    assert.equal(cycle.blocked_reason, "sample_flood");
    const db = openDb(sqlitePath);
    try {
      const row = db
        .prepare("SELECT state FROM sample_groups WHERE project_id = ?")
        .get(projectId) as { state: string };
      assert.equal(row.state, "quarantined");
    } finally {
      db.close();
    }
  });

  it("safe sample group becomes a draft eval candidate", async () => {
    const seeded = seedLastFullAndDraft();
    await postSample(seeded.lastFullId, "vendor_error");
    await configure({}, "cfg-candidate");
    const cycle = await runCycle("cycle-candidate");
    assert.equal(cycle.status, "blocked");
    assert.equal(cycle.pending_action, "promote_sample");
    assert.equal(cycle.blocked_reason, "person_mark_required");
    assert.equal(cycle.decision_ids.length, 1);
    const db = openDb(sqlitePath);
    try {
      const group = db
        .prepare("SELECT state FROM sample_groups WHERE project_id = ?")
        .get(projectId) as { state: string };
      assert.equal(group.state, "candidate");
      const evalSet = db
        .prepare("SELECT previous_eval_set_id FROM eval_sets WHERE id = ?")
        .get(cycle.decision_ids[0]) as { previous_eval_set_id: string };
      assert.ok(evalSet.previous_eval_set_id);
    } finally {
      db.close();
    }
  });

  it("live report includes automation status", async () => {
    seedLastFullAndDraft();
    await configure({ auto_canary: false }, "cfg-report");
    const cycle = await runCycle("cycle-report");
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/get_live_report",
      headers: authHeaders(),
      payload: { project_id: projectId },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      automation_mode: string;
      last_cycle: { cycle_id: string } | null;
      blocked_reason: string | null;
      audit_ids: string[];
    };
    assert.equal(body.automation_mode, "guarded");
    assert.equal(body.last_cycle?.cycle_id, cycle.cycle_id);
    assert.equal(body.blocked_reason, "no_action");
    assert.ok(body.audit_ids.length > 0);
  });
});
