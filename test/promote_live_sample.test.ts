import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { listMembers } from "../src/eval-set.js";
import { newRecId, newRunId, newSampleId } from "../src/ids.js";
import { buildSampleUrl, signSampleToken } from "../src/routes/sample.js";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
import { promoteLiveSampleOutputSchema } from "../src/tools/schema.js";
import { ASK_HUMAN, ErrorCode, isAgentError } from "../src/tools/types.js";
import { seedFiveTrustedEvals } from "./helpers/run-fixtures.js";

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

type PromoteSuccess = {
  eval_id: string;
  eval_set_id: string;
  previous_eval_set_id: string;
  version: number;
  score_how: "code" | "person";
  trusted: boolean;
  status: string;
  old_eval_ids: string[];
  mark_url: string | null;
  sample_url: string;
  live_traffic_changed: boolean;
  next_action: {
    tool: string | null;
    args: Record<string, unknown>;
    ask_human: string | null;
  };
};

const PROGRAM_CHECK = {
  kind: "field_equals" as const,
  expected: { path: "total_cents", exists: true },
};

describe("promote_live_sample (R4)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let oldEvalIds: string[];
  let policyId: string;
  let sampleId: string;
  let recId = "";
  let openRouterCalled = false;

  const redactedInput = "Name the invoice total.";
  const redactedOutput = "The vendor returned HTTP 503.";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-promote-sample-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    openRouterCalled = false;
    const openRouterClient = createMockOpenRouter(() => {
      openRouterCalled = true;
      throw new Error("promote_live_sample must not call OpenRouter");
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

    const db = new Database(sqlitePath);
    try {
      const seeded = seedFiveTrustedEvals(db, projectId);
      evalSetId = seeded.evalSetId;
      oldEvalIds = seeded.evalIds;
      recId = newRecId();
      const runId = newRunId();
      const now = new Date().toISOString();
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
        "openai/gpt-4.1-mini",
        JSON.stringify(["openai/gpt-4.1-nano"]),
        now,
      );
      db.prepare(
        `INSERT INTO named_model_approvals (recommendation_id, decision, decided_at)
         VALUES (?, 'approved', ?)`,
      ).run(recId, now);
    } finally {
      db.close();
    }

    const compiled = await app.inject({
      method: "POST",
      url: "/v1/tools/compile_policy",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        recommendation_id: recId,
        eval_set_id: evalSetId,
        idempotency_key: "compile-for-promote",
      },
    });
    assert.equal(compiled.statusCode, 200);
    const compiledBody = compiled.json() as {
      policy_id: string;
      approve_url: string;
    };
    policyId = compiledBody.policy_id;
    const approveParsed = new URL(compiledBody.approve_url);
    const approve = await app.inject({
      method: "POST",
      url: "/compile-approve",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: {
        policy_id: approveParsed.searchParams.get("policy_id"),
        token: approveParsed.searchParams.get("token"),
        decision: "approved",
      },
    });
    assert.equal(approve.statusCode, 200);

    sampleId = newSampleId();
    const ingested = await app.inject({
      method: "POST",
      url: "/v1/runtime/samples",
      headers: authHeaders(),
      payload: {
        sample_id: sampleId,
        project_id: projectId,
        policy_id: policyId,
        model_id: "openai/gpt-4.1-nano",
        why: "vendor_error",
        input_redacted: redactedInput,
        output_redacted: redactedOutput,
        captured_at: "2026-08-26T16:00:00.000Z",
      },
    });
    assert.equal(ingested.statusCode, 200);
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function promote(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/v1/tools/promote_live_sample",
      headers: authHeaders(),
      payload,
    });
  }

  async function getLastFull() {
    return app.inject({
      method: "GET",
      url: `/v1/runtime/policies/${projectId}`,
      headers: authHeaders(),
    });
  }

  function samplePath(id = sampleId): string {
    const token = signSampleToken(apiKey, id);
    return `/sample?sample_id=${encodeURIComponent(id)}&token=${token}`;
  }

  it("program_check → new ste_, old evals copied, previous ste_ frozen, code trusted, run_evals", async () => {
    const res = await promote({
      project_id: projectId,
      sample_id: sampleId,
      program_check: PROGRAM_CHECK,
      idempotency_key: "promote-code-1",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as PromoteSuccess;
    const parsed = promoteLiveSampleOutputSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed));

    assert.match(body.eval_id, /^cas_/);
    assert.match(body.eval_set_id, /^ste_/);
    assert.notEqual(body.eval_set_id, evalSetId);
    assert.equal(body.previous_eval_set_id, evalSetId);
    assert.equal(body.version, 2);
    assert.equal(body.score_how, "code");
    assert.equal(body.trusted, true);
    assert.equal(body.status, "trusted");
    assert.equal(body.mark_url, null);
    assert.equal(body.live_traffic_changed, false);
    assert.equal(body.next_action.tool, "run_evals");
    assert.equal(body.next_action.args.project_id, projectId);
    assert.equal(body.next_action.args.eval_set_id, body.eval_set_id);
    assert.equal(body.next_action.ask_human, null);
    assert.equal(
      body.sample_url,
      buildSampleUrl("http://test.local", sampleId, signSampleToken(apiKey, sampleId)),
    );
    assert.deepEqual([...body.old_eval_ids].sort(), [...oldEvalIds].sort());
    assert.equal(openRouterCalled, false);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const v1Count = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM eval_set_members WHERE eval_set_id = ?",
          )
          .get(evalSetId) as { n: number }
      ).n;
      assert.equal(v1Count, oldEvalIds.length);
      const v1Set = db
        .prepare("SELECT version FROM eval_sets WHERE id = ?")
        .get(evalSetId) as { version: number };
      assert.equal(v1Set.version, 1);
      const v2Members = listMembers(db, body.eval_set_id);
      assert.equal(v2Members.length, oldEvalIds.length + 1);
      assert.ok(v2Members.some((m) => m.eval_id === body.eval_id));
    } finally {
      db.close();
    }
  });

  it("without program_check → person draft, queue_for_labeling, mark_url", async () => {
    const res = await promote({
      project_id: projectId,
      sample_id: sampleId,
      idempotency_key: "promote-person-1",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as PromoteSuccess;
    assert.equal(promoteLiveSampleOutputSchema.safeParse(body).success, true);
    assert.equal(body.score_how, "person");
    assert.equal(body.trusted, false);
    assert.equal(body.status, "draft");
    assert.equal(body.next_action.tool, "queue_for_labeling");
    assert.equal(body.next_action.args.project_id, projectId);
    assert.equal(body.next_action.args.eval_set_id, body.eval_set_id);
    assert.equal(typeof body.mark_url, "string");
    assert.ok((body.mark_url ?? "").length > 0);
    assert.equal(body.live_traffic_changed, false);
  });

  it("same idempotency_key returns the same eval and does not add a second", async () => {
    const payload = {
      project_id: projectId,
      sample_id: sampleId,
      program_check: PROGRAM_CHECK,
      idempotency_key: "promote-idem-1",
    };
    const first = await promote(payload);
    const second = await promote(payload);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const a = first.json() as PromoteSuccess;
    const b = second.json() as PromoteSuccess;
    assert.equal(a.eval_id, b.eval_id);
    assert.equal(a.eval_set_id, b.eval_set_id);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const setCount = (
        db
          .prepare("SELECT COUNT(*) AS n FROM eval_sets WHERE project_id = ?")
          .get(projectId) as { n: number }
      ).n;
      assert.equal(setCount, 2);
      const newEvalCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM evals
             WHERE id NOT IN (${oldEvalIds.map(() => "?").join(",")})`,
          )
          .get(...oldEvalIds) as { n: number }
      ).n;
      assert.equal(newEvalCount, 1);
    } finally {
      db.close();
    }
  });

  it("unknown smp_ returns NOT_A_SAMPLE", async () => {
    const res = await promote({
      project_id: projectId,
      sample_id: newSampleId(),
      idempotency_key: "promote-missing",
    });
    assert.equal(res.statusCode, 404);
    assert.equal(isAgentError(res.json()), true);
    const body = res.json() as {
      code: string;
      message: string;
      next_action: { tool: string | null; args: Record<string, unknown>; ask_human: string | null };
      suggested_args: Record<string, unknown>;
    };
    assert.equal(body.code, ErrorCode.NOT_A_SAMPLE);
    assert.equal(body.next_action.tool, "get_live_report");
    assert.deepEqual(body.next_action.args, { project_id: projectId });
    assert.deepEqual(body.suggested_args, { project_id: projectId });
    assert.doesNotMatch(body.message, /\bshould\b/);
    assert.doesNotMatch(body.message, /\bcould\b/);
    assert.doesNotMatch(body.message, /\bmight\b/);
  });

  it("after promote, GET last full policy id is unchanged", async () => {
    const before = await getLastFull();
    assert.equal(before.statusCode, 200);
    const beforeId = (before.json() as { last_full: { policy_id: string } }).last_full.policy_id;
    assert.equal(beforeId, policyId);

    const res = await promote({
      project_id: projectId,
      sample_id: sampleId,
      program_check: PROGRAM_CHECK,
      idempotency_key: "promote-last-full",
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as PromoteSuccess).live_traffic_changed, false);

    const after = await getLastFull();
    assert.equal(after.statusCode, 200);
    assert.equal((after.json() as { last_full: { policy_id: string } }).last_full.policy_id, beforeId);
  });

  it("rejects an extra input field", async () => {
    const res = await promote({
      project_id: projectId,
      sample_id: sampleId,
      idempotency_key: "promote-extra",
      unexpected_field: true,
    });
    assert.equal(res.statusCode, 400);
    assert.equal(isAgentError(res.json()), true);
    assert.equal((res.json() as { code: string }).code, ErrorCode.INVALID_INPUT);
  });

  it("GET sample screen shows redacted text only", async () => {
    const res = await app.inject({
      method: "GET",
      url: samplePath(),
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(
      res.body,
      new RegExp(redactedInput.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(
      res.body,
      new RegExp(redactedOutput.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.doesNotMatch(res.body, /<table/i);
    assert.doesNotMatch(res.body, /\bshould\b/);
    assert.doesNotMatch(res.body, /\bcould\b/);
    assert.doesNotMatch(res.body, /\bmight\b/);
    assert.doesNotMatch(res.body, /unit test/i);
  });

  it("screen POST promote with pasted check → same J5 outcome", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sample",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: {
        sample_id: sampleId,
        token: signSampleToken(apiKey, sampleId),
        decision: "promote",
        program_check: JSON.stringify(PROGRAM_CHECK),
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as PromoteSuccess;
    assert.equal(promoteLiveSampleOutputSchema.safeParse(body).success, true);
    assert.match(body.eval_id, /^cas_/);
    assert.notEqual(body.eval_set_id, evalSetId);
    assert.equal(body.previous_eval_set_id, evalSetId);
    assert.equal(body.score_how, "code");
    assert.equal(body.trusted, true);
    assert.equal(body.status, "trusted");
    assert.equal(body.next_action.tool, "run_evals");
    assert.equal(body.live_traffic_changed, false);
    assert.deepEqual([...body.old_eval_ids].sort(), [...oldEvalIds].sort());
    assert.equal(openRouterCalled, false);
  });

  it("screen POST drop → later promote tool fails NOT_A_SAMPLE", async () => {
    const dropped = await app.inject({
      method: "POST",
      url: "/sample",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: {
        sample_id: sampleId,
        token: signSampleToken(apiKey, sampleId),
        decision: "drop",
      },
    });
    assert.equal(dropped.statusCode, 200);
    const dropBody = dropped.json() as { live_traffic_changed?: boolean };
    assert.equal(dropBody.live_traffic_changed, false);

    const res = await promote({
      project_id: projectId,
      sample_id: sampleId,
      program_check: PROGRAM_CHECK,
      idempotency_key: "promote-after-drop",
    });
    assert.equal(res.statusCode, 404);
    assert.equal(isAgentError(res.json()), true);
    assert.equal((res.json() as { code: string }).code, ErrorCode.NOT_A_SAMPLE);
    assert.equal(
      (res.json() as { next_action: { tool: string | null } }).next_action.tool,
      "get_live_report",
    );
  });

  it("live_traffic_changed is false", async () => {
    const res = await promote({
      project_id: projectId,
      sample_id: sampleId,
      program_check: PROGRAM_CHECK,
      idempotency_key: "promote-traffic-flag",
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as PromoteSuccess).live_traffic_changed, false);
  });

  it("ASK_HUMAN includes open sample_url", () => {
    assert.ok((ASK_HUMAN as readonly string[]).includes("open sample_url"));
  });
});
