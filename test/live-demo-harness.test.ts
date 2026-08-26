import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { listMembers } from "../src/eval-set.js";
import { newEvalSetId, newJobId, newRecId, newRunId } from "../src/ids.js";
import { assessLiveRequest, type LiveAssessCache } from "../src/live/assess.js";
import { createLiveSdk, LiveSdkError } from "../src/live/sdk.js";
import type { RuntimePolicyDocument } from "../src/policy.js";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
import { ErrorCode } from "../src/tools/types.js";
import { seedFiveTrustedEvals } from "./helpers/run-fixtures.js";
import {
  addedLatencyMs,
  createHopFetch,
  idForCanaryBucket,
  openRouterOk,
  OPENROUTER_CHAT_URL,
  p99Ms,
  postModel,
  type HopFetchCall,
} from "./helpers/live-demo.js";

const apiKey = "test-key-not-a-secret";
const vendorKey = "sk-or-v1-app-vendor-key";
const evalrouterUrl = "http://test.local";
const LAST_FULL_MODEL = "openai/gpt-4.1-mini";
const BACKUP_ONE = "openai/gpt-4.1-nano";
const BACKUP_TWO = "google/gemini-flash-1.5";
const CANARY_MODEL = "anthropic/claude-3-haiku";
const INVOICE_PROMPT = "Return JSON with line_items[] and total_cents.";
const GOOD_INVOICE = '{"line_items":[{"sku":"a","qty":1}],"total_cents":100}';
const BAD_INVOICE = '{"line_items":[{"sku":"a","qty":1}]}';
const PROGRAM_CHECK = {
  kind: "field_equals" as const,
  expected: { path: "total_cents", exists: true },
};
const P99_SAMPLE_COUNT = 120;
const P99_BUDGET_MS = 5;

function authHeaders(key = apiKey): {
  authorization: string;
  "content-type": string;
} {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

type RuntimeGet = RuntimePolicyDocument;

type LiveReportBody = {
  policy_id: string | null;
  canary: boolean;
  intended_split: number;
  observed_split: number;
  samples: Array<{ sample_id: string; why: string }>;
};

describe("Live added-latency helpers", () => {
  it("p99 helper uses the 99th percentile of added wait", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(p99Ms(samples), 99);
    assert.equal(addedLatencyMs(8, 3), 5);
    assert.equal(addedLatencyMs(2, 5), 0);
  });
});

describe("Live demo harness (L8)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let lastKnownPath: string;
  let projectId: string;
  let controlPlaneUp: boolean;
  let failPrimaryOnce: boolean;
  let vendorBody: string;
  let hop: ReturnType<typeof createHopFetch>;
  let sdk: ReturnType<typeof createLiveSdk>;
  let appClosed: boolean;
  let controlPlaneOpenRouterCalls: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-live-demo-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    lastKnownPath = join(dir, "last-known.json");
    controlPlaneUp = true;
    failPrimaryOnce = false;
    vendorBody = GOOD_INVOICE;
    appClosed = false;
    controlPlaneOpenRouterCalls = 0;

    app = await buildApp({
      sqlitePath,
      apiKey,
      baseUrl: evalrouterUrl,
      openRouterClient: createMockOpenRouter(() => {
        controlPlaneOpenRouterCalls += 1;
        throw new Error("Live demo must not call OpenRouter from the control plane");
      }),
    });

    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeaders(),
      payload: {},
    });
    assert.equal(proj.statusCode, 200);
    projectId = (proj.json() as { project_id: string }).project_id;

    hop = createHopFetch({
      app,
      evalrouterUrl,
      isControlPlaneUp: () => controlPlaneUp,
      vendorResponse: (model) => {
        if (failPrimaryOnce && model === LAST_FULL_MODEL) {
          failPrimaryOnce = false;
          return new Response("vendor down", { status: 503 });
        }
        return openRouterOk(vendorBody);
      },
    });

    sdk = createLiveSdk({
      projectId,
      evalrouterUrl,
      evalrouterKey: apiKey,
      vendorKey,
      lastKnownPath,
      pollMs: 30_000,
      fetch: hop.fetch,
    });
  });

  afterEach(async () => {
    sdk.stop();
    if (!appClosed) {
      await app.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function seedApprovedRec(opts: {
    namedModelId: string;
    backups: string[];
    evalSetId?: string;
  }): { recId: string; evalSetId: string; evalIds: string[] } {
    const recId = newRecId();
    const runId = newRunId();
    const now = new Date().toISOString();
    const db = new Database(sqlitePath);
    try {
      let evalSetId = opts.evalSetId;
      let evalIds: string[] = [];
      if (!evalSetId) {
        const seeded = seedFiveTrustedEvals(db, projectId);
        evalSetId = seeded.evalSetId;
        evalIds = seeded.evalIds;
      } else {
        const jobId = newJobId();
        db.prepare(
          `INSERT INTO jobs (id, project_id, description, limits, created_at)
           VALUES (?, ?, ?, NULL, ?)`,
        ).run(jobId, projectId, "JSON invoice canary job", now);
        db.prepare(
          `INSERT INTO eval_sets
            (id, project_id, job_id, version, previous_eval_set_id, frozen_at, created_at)
           VALUES (?, ?, ?, 1, NULL, ?, ?)`,
        ).run(evalSetId, projectId, jobId, now, now);
      }
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
      ).run(
        recId,
        projectId,
        evalSetId,
        runId,
        opts.namedModelId,
        JSON.stringify(opts.backups),
        now,
      );
      db.prepare(
        `INSERT INTO named_model_approvals (recommendation_id, decision, decided_at)
         VALUES (?, 'approved', ?)`,
      ).run(recId, now);
      return { recId, evalSetId, evalIds };
    } finally {
      db.close();
    }
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

  async function getPolicy() {
    return app.inject({
      method: "GET",
      url: `/v1/runtime/policies/${projectId}`,
      headers: authHeaders(),
    });
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

  async function propose(intent: "canary" | "full" | "rollback", key: string) {
    return app.inject({
      method: "POST",
      url: "/v1/tools/propose_rollout",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        intent,
        idempotency_key: key,
      },
    });
  }

  async function decideRollout(approveUrl: string, decision: "approved" | "rejected") {
    const parsed = new URL(approveUrl);
    return app.inject({
      method: "POST",
      url: "/rollout-approve",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: {
        rollout_id: parsed.searchParams.get("rollout_id"),
        token: parsed.searchParams.get("token"),
        decision,
      },
    });
  }

  async function getReport() {
    return app.inject({
      method: "POST",
      url: "/v1/tools/get_live_report",
      headers: authHeaders(),
      payload: { project_id: projectId },
    });
  }

  function openRouterPosts(): HopFetchCall[] {
    return hop.calls.filter(
      (c) => c.method === "POST" && c.url.startsWith("https://openrouter.ai/"),
    );
  }

  function controlPlaneGets(): HopFetchCall[] {
    return hop.calls.filter(
      (c) => c.method === "GET" && c.url.includes("/v1/runtime/policies/"),
    );
  }

  function hopRunEvalsCalls(): HopFetchCall[] {
    return hop.calls.filter((c) => c.url.includes("/v1/tools/run_evals"));
  }

  async function waitUntil(pred: () => boolean, label: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 2000) {
      if (pred()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out: ${label}`);
  }

  function measureUsualPathAddedMs(cache: LiveAssessCache): number {
    const start = performance.now();
    const picked = assessLiveRequest({ user_id: "p99_user" }, cache);
    const addedMs = performance.now() - start;
    assert.equal(picked.primary.model_id, LAST_FULL_MODEL);
    return addedMs;
  }

  it("north-star loop: compile, hop, backup, sample, canary, full, rollback, kill control plane", async () => {
    const invoice = seedApprovedRec({
      namedModelId: LAST_FULL_MODEL,
      backups: [BACKUP_ONE, BACKUP_TWO],
    });
    assert.equal(invoice.evalIds.length, 5);

    const compiled = await compile(invoice.recId, invoice.evalSetId, "demo-compile-1");
    assert.equal(compiled.statusCode, 200);
    const compiledBody = compiled.json() as {
      policy_id: string;
      approve_url: string;
      live_traffic_changed: boolean;
    };
    assert.match(compiledBody.policy_id, /^pol_/);
    assert.equal(compiledBody.live_traffic_changed, false);
    assert.match(compiledBody.approve_url, /\/compile-approve/);

    const beforeApprove = await getPolicy();
    assert.equal(beforeApprove.statusCode, 404);

    await assert.rejects(
      () => sdk.start(),
      (err: unknown) => {
        assert.ok(err instanceof LiveSdkError);
        assert.equal(err.code, ErrorCode.NO_LAST_KNOWN_POLICY);
        return true;
      },
    );
    await assert.rejects(
      () => sdk.complete({ prompt: INVOICE_PROMPT }),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, ErrorCode.NO_LAST_KNOWN_POLICY);
        return true;
      },
    );
    assert.equal(openRouterPosts().length, 0);

    const approved = await decideCompile(compiledBody.approve_url, "approved");
    assert.equal(approved.statusCode, 200);
    assert.equal((approved.json() as { live_traffic_changed: boolean }).live_traffic_changed, false);

    const afterApprove = await getPolicy();
    assert.equal(afterApprove.statusCode, 200);
    const lastFullDoc = afterApprove.json() as RuntimeGet;
    assert.equal(lastFullDoc.last_full?.policy_id, compiledBody.policy_id);
    assert.equal(lastFullDoc.last_full?.primary.model_id, LAST_FULL_MODEL);
    assert.deepEqual(
      (lastFullDoc.last_full?.backups ?? []).map((b) => b.model_id),
      [BACKUP_ONE, BACKUP_TWO],
    );
    assert.equal(lastFullDoc.canary, null);
    assert.equal(lastFullDoc.canary_percent, 0);

    await sdk.start();
    assert.equal(existsSync(lastKnownPath), true);
    const getsAfterStart = controlPlaneGets().length;
    const live = await sdk.complete({ prompt: INVOICE_PROMPT });
    assert.equal(live.content, GOOD_INVOICE);
    assert.equal(live.model_id, LAST_FULL_MODEL);
    assert.equal(live.policy_id, compiledBody.policy_id);
    assert.equal(controlPlaneGets().length, getsAfterStart);

    const firstVendor = openRouterPosts()[0];
    assert.ok(firstVendor);
    assert.equal(firstVendor.url, OPENROUTER_CHAT_URL);
    const vendorPayload = JSON.parse(firstVendor.body ?? "{}") as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream?: boolean;
    };
    assert.equal(vendorPayload.model, LAST_FULL_MODEL);
    assert.equal(vendorPayload.messages[0]?.content, INVOICE_PROMPT);
    assert.equal("evals" in vendorPayload, false);
    assert.equal("run_evals" in vendorPayload, false);
    assert.equal(hopRunEvalsCalls().length, 0);

    const assessCache: LiveAssessCache = {
      last_full: lastFullDoc.last_full,
      canary: lastFullDoc.canary,
      canary_percent: lastFullDoc.canary_percent,
    };
    const warmup = measureUsualPathAddedMs(assessCache);
    assert.ok(warmup < 50, `warmup added wait ${warmup} ms`);
    const addedSamples: number[] = [];
    for (let i = 0; i < P99_SAMPLE_COUNT; i++) {
      addedSamples.push(measureUsualPathAddedMs(assessCache));
      const hopResult = await sdk.complete({
        prompt: INVOICE_PROMPT,
        user_id: "p99_user",
      });
      assert.equal(hopResult.model_id, LAST_FULL_MODEL);
    }
    const addedP99 = p99Ms(addedSamples);
    assert.ok(
      addedP99 <= P99_BUDGET_MS,
      `p99 added latency ${addedP99} ms exceeds ${P99_BUDGET_MS} ms`,
    );

    const postsBeforeBackup = openRouterPosts().length;
    failPrimaryOnce = true;
    const backupResult = await sdk.complete({ prompt: INVOICE_PROMPT });
    assert.equal(backupResult.content, GOOD_INVOICE);
    assert.equal(backupResult.model_id, BACKUP_ONE);
    const backupVendor = openRouterPosts().slice(postsBeforeBackup);
    assert.equal(backupVendor.length, 2);
    assert.equal(postModel(backupVendor[0].body), LAST_FULL_MODEL);
    assert.equal(postModel(backupVendor[1].body), BACKUP_ONE);
    assert.notEqual(postModel(backupVendor[1].body), BACKUP_TWO);
    assert.equal(sdk.stats().fallback_count, 1);

    vendorBody = BAD_INVOICE;
    const miss = await sdk.complete({ prompt: INVOICE_PROMPT });
    assert.equal(miss.content, BAD_INVOICE);
    assert.equal(hopRunEvalsCalls().length, 0);
    await sdk.reportMiss({ prompt: INVOICE_PROMPT, output: BAD_INVOICE });
    await waitUntil(
      () => hop.calls.some((c) => c.method === "POST" && c.url.includes("/v1/runtime/samples")),
      "sample upload",
    );
    const samplePost = hop.calls.find(
      (c) => c.method === "POST" && c.url.includes("/v1/runtime/samples"),
    );
    assert.ok(samplePost?.body);
    const sampleBody = JSON.parse(samplePost.body) as {
      sample_id: string;
      why: string;
      input_redacted: string;
      output_redacted: string;
    };
    assert.match(sampleBody.sample_id, /^smp_/);
    assert.equal(sampleBody.why, "app_reported");
    assert.equal(sampleBody.input_redacted.includes("sk-or-v1"), false);

    const policyBeforePromote = (await getPolicy()).json() as RuntimeGet;
    const promote = await app.inject({
      method: "POST",
      url: "/v1/tools/promote_live_sample",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        sample_id: sampleBody.sample_id,
        program_check: PROGRAM_CHECK,
        idempotency_key: "demo-promote-1",
      },
    });
    assert.equal(promote.statusCode, 200);
    const promoted = promote.json() as {
      eval_set_id: string;
      previous_eval_set_id: string;
      live_traffic_changed: boolean;
      old_eval_ids: string[];
      next_action: { tool: string | null };
    };
    assert.match(promoted.eval_set_id, /^ste_/);
    assert.notEqual(promoted.eval_set_id, invoice.evalSetId);
    assert.equal(promoted.previous_eval_set_id, invoice.evalSetId);
    assert.equal(promoted.live_traffic_changed, false);
    assert.deepEqual([...promoted.old_eval_ids].sort(), [...invoice.evalIds].sort());
    const memberDb = new Database(sqlitePath, { readonly: true });
    try {
      assert.equal(listMembers(memberDb, promoted.eval_set_id).length, invoice.evalIds.length + 1);
    } finally {
      memberDb.close();
    }
    const policyAfterPromote = (await getPolicy()).json() as RuntimeGet;
    assert.equal(policyAfterPromote.last_full?.policy_id, policyBeforePromote.last_full?.policy_id);

    vendorBody = GOOD_INVOICE;
    const canaryRec = seedApprovedRec({
      namedModelId: CANARY_MODEL,
      backups: [],
      evalSetId: newEvalSetId(),
    });
    const canaryCompiled = await compile(canaryRec.recId, canaryRec.evalSetId, "demo-compile-canary");
    assert.equal(canaryCompiled.statusCode, 200);
    assert.equal((canaryCompiled.json() as { live_traffic_changed: boolean }).live_traffic_changed, false);
    await decideCompile((canaryCompiled.json() as { approve_url: string }).approve_url, "approved");
    const afterSecondCompile = (await getPolicy()).json() as RuntimeGet;
    assert.equal(afterSecondCompile.last_full?.policy_id, compiledBody.policy_id);

    const proposedCanary = await propose("canary", "demo-canary");
    assert.equal(proposedCanary.statusCode, 200);
    assert.equal((proposedCanary.json() as { live_traffic_changed: boolean }).live_traffic_changed, false);
    const afterProposeCanary = (await getPolicy()).json() as RuntimeGet;
    assert.equal(afterProposeCanary.last_full?.policy_id, compiledBody.policy_id);
    assert.equal(afterProposeCanary.canary, null);
    assert.equal(afterProposeCanary.canary_percent, 0);

    await decideRollout((proposedCanary.json() as { approve_url: string }).approve_url, "approved");
    const canaryDoc = (await getPolicy()).json() as RuntimeGet;
    assert.equal(canaryDoc.last_full?.policy_id, compiledBody.policy_id);
    assert.equal(canaryDoc.canary?.primary.model_id, CANARY_MODEL);
    assert.equal(canaryDoc.canary_percent, 5);
    assert.notEqual(canaryDoc.canary_percent, 50);

    await sdk.start();
    const missingIds = await sdk.complete({ prompt: INVOICE_PROMPT });
    assert.equal(missingIds.model_id, LAST_FULL_MODEL);
    const canaryUser = idForCanaryBucket(true);
    const fullUser = idForCanaryBucket(false);
    const canaryHit = await sdk.complete({ prompt: INVOICE_PROMPT, user_id: canaryUser });
    const fullHit = await sdk.complete({ prompt: INVOICE_PROMPT, user_id: fullUser });
    assert.equal(canaryHit.model_id, CANARY_MODEL);
    assert.equal(fullHit.model_id, LAST_FULL_MODEL);
    const hopStats = sdk.stats();
    assert.equal(hopStats.intended_percent, 5);
    assert.notEqual(hopStats.intended_percent, 50);
    assert.ok(hopStats.observed_percent > 0);

    await sdk.start();
    const statsPosts = hop.calls.filter(
      (c) => c.method === "POST" && c.url.includes("/v1/runtime/stats"),
    );
    assert.ok(statsPosts.length >= 1);
    const report = (await getReport()).json() as LiveReportBody;
    assert.equal(report.canary, true);
    assert.equal(report.intended_split, 5);
    assert.notEqual(report.intended_split, 50);
    assert.ok(typeof report.observed_split === "number");
    assert.ok(report.observed_split > 0);
    assert.ok(report.samples.some((s) => s.why === "app_reported"));

    const proposedFull = await propose("full", "demo-full");
    assert.equal((proposedFull.json() as { live_traffic_changed: boolean }).live_traffic_changed, false);
    const beforeFull = (await getPolicy()).json() as RuntimeGet;
    assert.equal(beforeFull.last_full?.policy_id, compiledBody.policy_id);
    await decideRollout((proposedFull.json() as { approve_url: string }).approve_url, "approved");
    const afterFull = (await getPolicy()).json() as RuntimeGet;
    assert.equal(afterFull.last_full?.primary.model_id, CANARY_MODEL);
    assert.equal(afterFull.canary, null);
    assert.equal(afterFull.canary_percent, 0);

    controlPlaneOpenRouterCalls = 0;
    const proposedRollback = await propose("rollback", "demo-rollback");
    assert.equal((proposedRollback.json() as { live_traffic_changed: boolean }).live_traffic_changed, false);
    await decideRollout((proposedRollback.json() as { approve_url: string }).approve_url, "approved");
    assert.equal(controlPlaneOpenRouterCalls, 0);
    assert.equal(hopRunEvalsCalls().length, 0);
    const afterRollback = (await getPolicy()).json() as RuntimeGet;
    assert.equal(afterRollback.last_full?.policy_id, compiledBody.policy_id);
    assert.equal(afterRollback.last_full?.primary.model_id, LAST_FULL_MODEL);

    await sdk.start();
    const rolled = await sdk.complete({ prompt: INVOICE_PROMPT, user_id: canaryUser });
    assert.equal(rolled.model_id, LAST_FULL_MODEL);

    const getsBeforeKill = controlPlaneGets().length;
    controlPlaneUp = false;
    await app.close();
    appClosed = true;
    const afterKill = await sdk.complete({ prompt: INVOICE_PROMPT });
    assert.equal(afterKill.content, GOOD_INVOICE);
    assert.equal(afterKill.model_id, LAST_FULL_MODEL);
    assert.equal(controlPlaneGets().length, getsBeforeKill);

    sdk.stop();
    const failOpen = createLiveSdk({
      projectId,
      evalrouterUrl,
      evalrouterKey: apiKey,
      vendorKey,
      lastKnownPath,
      pollMs: 30_000,
      fetch: hop.fetch,
    });
    await failOpen.start();
    const fromFile = await failOpen.complete({ prompt: INVOICE_PROMPT });
    assert.equal(fromFile.model_id, LAST_FULL_MODEL);
    failOpen.stop();
  });
});
