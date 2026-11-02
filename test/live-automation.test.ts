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
    dir = mkdtempSync(join(tmpdir(), "openeval-v2-automation-"));
    sqlitePath = join(dir, "openeval.sqlite");
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

  type Arm = {
    policy_id: string;
    request_count?: number;
    fallback_count?: number;
    error_count?: number;
    pii_blocked_miss_count?: number;
    latency_ms_sum?: number;
    latency_count?: number;
    cost_usd_sum?: number;
    cost_count?: number;
    quality_checked?: number;
    quality_failed?: number;
  };

  async function postArms(arms: Arm[]): Promise<void> {
    const full = arms.map((a) => ({
      request_count: 0,
      fallback_count: 0,
      error_count: 0,
      pii_blocked_miss_count: 0,
      latency_ms_sum: 0,
      latency_count: 0,
      cost_usd_sum: 0,
      cost_count: 0,
      quality_checked: 0,
      quality_failed: 0,
      ...a,
    }));
    const total = full.reduce((n, a) => n + a.request_count, 0);
    const res = await app.inject({
      method: "POST",
      url: "/v1/runtime/stats",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        hashed_request_count: total,
        canary_request_count: 0,
        fallback_count: 0,
        request_count: total,
        arms: full,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
  }

  /** Moves the canary start into the past so the age gate can pass. */
  function ageCanary(seconds: number): void {
    const db = openDb(sqlitePath);
    try {
      db.prepare(
        "UPDATE project_live_state SET canary_started_at = ? WHERE project_id = ?",
      ).run(new Date(Date.now() - seconds * 1000).toISOString(), projectId);
    } finally {
      db.close();
    }
  }

  async function startCanary(
    rules: Record<string, unknown>,
    key: string,
  ): Promise<{ lastFullId: string; draftId: string }> {
    const seeded = seedLastFullAndDraft();
    await configure(
      {
        auto_canary: true,
        auto_full: true,
        auto_rollback: true,
        allowed_models: [draftModel],
        ...rules,
      },
      `cfg-${key}`,
    );
    assert.equal((await runCycle(`cycle-${key}-canary`)).pending_action, "auto_canary");
    return seeded;
  }

  it("rolls back a canary with bad fallbacks even when project traffic looks fine", async () => {
    const seeded = await startCanary({ max_fallback_rate: 0.05 }, "arm-fallback");
    // 1000 good full-policy requests hide 10 canary fallbacks in a project-wide rate.
    await postArms([
      { policy_id: seeded.lastFullId, request_count: 1000 },
      { policy_id: seeded.draftId, request_count: 50, fallback_count: 10 },
    ]);
    const cycle = await runCycle("cycle-arm-fallback");
    assert.equal(cycle.pending_action, "auto_rollback");
    const doc = await getPolicy();
    assert.equal(doc.canary, null);
    assert.equal(doc.last_full?.policy_id, seeded.lastFullId);
  });

  it("rolls back when the canary miss rate is over max_miss_rate", async () => {
    const seeded = await startCanary({ max_miss_rate: 0.01 }, "arm-miss");
    await postArms([
      { policy_id: seeded.lastFullId, request_count: 100 },
      { policy_id: seeded.draftId, request_count: 40, pii_blocked_miss_count: 2 },
    ]);
    const cycle = await runCycle("cycle-arm-miss");
    assert.equal(cycle.pending_action, "auto_rollback");
    const db = openDb(sqlitePath);
    try {
      const row = db
        .prepare(
          "SELECT body_json FROM decision_audit_events WHERE project_id = ? AND event_type = 'auto_rollback'",
        )
        .get(projectId) as { body_json: string };
      assert.equal((JSON.parse(row.body_json) as { reason: string }).reason, "miss_rate_high");
    } finally {
      db.close();
    }
  });

  it("rolls back when canary answers fail live checks more than the full policy", async () => {
    const seeded = await startCanary({ max_quality_fail_rate: 0.5 }, "arm-quality");
    await postArms([
      { policy_id: seeded.lastFullId, request_count: 400, quality_checked: 400, quality_failed: 4 },
      { policy_id: seeded.draftId, request_count: 200, quality_checked: 200, quality_failed: 30 },
    ]);
    const cycle = await runCycle("cycle-arm-quality");
    assert.equal(cycle.pending_action, "auto_rollback");
  });

  it("rolls back when the canary is much slower or costlier", async () => {
    const slow = await startCanary({}, "arm-latency");
    await postArms([
      { policy_id: slow.lastFullId, request_count: 100, latency_ms_sum: 100 * 400, latency_count: 100 },
      { policy_id: slow.draftId, request_count: 100, latency_ms_sum: 100 * 900, latency_count: 100 },
    ]);
    assert.equal((await runCycle("cycle-arm-latency")).pending_action, "auto_rollback");
  });

  it("rolls back when the canary costs much more per answer", async () => {
    const seeded = await startCanary({}, "arm-cost");
    await postArms([
      { policy_id: seeded.lastFullId, request_count: 100, cost_usd_sum: 0.1, cost_count: 100 },
      { policy_id: seeded.draftId, request_count: 100, cost_usd_sum: 0.3, cost_count: 100 },
    ]);
    assert.equal((await runCycle("cycle-arm-cost")).pending_action, "auto_rollback");
  });

  it("does not roll back on a small noisy canary sample", async () => {
    const seeded = await startCanary({ min_canary_requests: 1000 }, "arm-noise");
    await postArms([
      { policy_id: seeded.lastFullId, request_count: 1000, fallback_count: 10 },
      { policy_id: seeded.draftId, request_count: 10, fallback_count: 1 },
    ]);
    const cycle = await runCycle("cycle-arm-noise");
    assert.equal(cycle.status, "blocked");
    assert.equal(cycle.blocked_reason, "canary_age_low");
    assert.equal((await getPolicy()).canary?.policy_id, seeded.draftId);
  });

  it("waits for the canary age before full rollout", async () => {
    const seeded = await startCanary({ min_canary_requests: 10 }, "arm-age");
    await postArms([{ policy_id: seeded.draftId, request_count: 50 }]);
    const cycle = await runCycle("cycle-arm-age");
    assert.equal(cycle.blocked_reason, "canary_age_low");
    assert.equal((await getPolicy()).canary?.policy_id, seeded.draftId);
  });

  it("counts canary traffic, not project traffic, before full rollout", async () => {
    const seeded = await startCanary({ min_canary_age_s: 0, min_canary_requests: 200 }, "arm-traffic");
    await postArms([
      { policy_id: seeded.lastFullId, request_count: 5000 },
      { policy_id: seeded.draftId, request_count: 50 },
    ]);
    const cycle = await runCycle("cycle-arm-traffic");
    assert.equal(cycle.blocked_reason, "canary_traffic_low");
  });

  it("blocks full rollout when only old project-wide stats exist", async () => {
    await startCanary({ min_canary_age_s: 0 }, "arm-legacy");
    await postStats(0, 5000);
    const cycle = await runCycle("cycle-arm-legacy");
    assert.equal(cycle.blocked_reason, "canary_stats_missing");
  });

  it("ignores live evidence from before the canary started", async () => {
    const seeded = await startCanary({ min_canary_age_s: 0, min_canary_requests: 100 }, "arm-window");
    await postArms([{ policy_id: seeded.draftId, request_count: 500 }]);
    // Restart the canary clock: the 500 requests are now older than the canary.
    const db = openDb(sqlitePath);
    try {
      db.prepare(
        "UPDATE project_live_state SET canary_started_at = ? WHERE project_id = ?",
      ).run(new Date(Date.now() + 1000).toISOString(), projectId);
    } finally {
      db.close();
    }
    const cycle = await runCycle("cycle-arm-window");
    assert.equal(cycle.blocked_reason, "canary_stats_missing");
  });

  it("promotes a healthy canary with enough of its own traffic", async () => {
    const seeded = await startCanary({ min_canary_requests: 200 }, "arm-promote");
    ageCanary(3600);
    await postArms([
      {
        policy_id: seeded.lastFullId,
        request_count: 4000,
        fallback_count: 40,
        latency_ms_sum: 4000 * 500,
        latency_count: 4000,
        quality_checked: 4000,
        quality_failed: 40,
      },
      {
        policy_id: seeded.draftId,
        request_count: 250,
        fallback_count: 2,
        latency_ms_sum: 250 * 450,
        latency_count: 250,
        quality_checked: 250,
        quality_failed: 2,
      },
    ]);
    const cycle = await runCycle("cycle-arm-promote");
    assert.equal(cycle.pending_action, "auto_full");
    const doc = await getPolicy();
    assert.equal(doc.last_full?.policy_id, seeded.draftId);
    assert.equal(doc.canary, null);
  });

  it("an unhealthy canary is not promoted when auto rollback is off", async () => {
    const seeded = await startCanary(
      { auto_rollback: false, min_canary_age_s: 0, min_canary_requests: 10 },
      "arm-no-rollback",
    );
    await postArms([{ policy_id: seeded.draftId, request_count: 100, error_count: 20 }]);
    const cycle = await runCycle("cycle-arm-no-rollback");
    assert.equal(cycle.blocked_reason, "error_rate_high");
    assert.equal((await getPolicy()).canary?.policy_id, seeded.draftId);
  });

  it("live report shows canary and full policy evidence", async () => {
    const seeded = await startCanary({}, "arm-report");
    await postArms([
      { policy_id: seeded.lastFullId, request_count: 30 },
      { policy_id: seeded.draftId, request_count: 3 },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/get_live_report",
      headers: authHeaders(),
      payload: { project_id: projectId },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      canary_evidence: {
        canary: { policy_id: string; request_count: number };
        control: { request_count: number } | null;
      } | null;
    };
    assert.equal(body.canary_evidence?.canary.policy_id, seeded.draftId);
    assert.equal(body.canary_evidence?.canary.request_count, 3);
    assert.equal(body.canary_evidence?.control?.request_count, 30);
  });
});
