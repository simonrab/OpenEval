import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { newEvalSetId, newPolicyId, newRecId, newSampleId } from "../src/ids.js";
import { MCP_TOOLS } from "../src/mcp/tools.js";
import {
  activateCanary,
  promoteToLastFullIfNone,
  putPolicy,
  type UnsignedPolicy,
} from "../src/policy.js";
import { dropSample } from "../src/samples.js";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
import { getLiveReportOutputSchema, parseToolInput } from "../src/tools/schema.js";
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

function sampleUnsigned(projectId: string, extra?: Partial<UnsignedPolicy>): UnsignedPolicy {
  return {
    policy_id: newPolicyId(),
    version: 1,
    previous_policy_id: null,
    project_id: projectId,
    rec_id: newRecId(),
    ste_id: newEvalSetId(),
    compiled_at: "2026-08-26T12:00:00.000Z",
    primary: { model_id: "openai/gpt-4.1-mini", timeout_ms: 2500 },
    backups: [],
    canary: null,
    ...extra,
  };
}

type LiveReportBody = {
  policy_id: string | null;
  canary: boolean;
  intended_split: number;
  observed_split: number;
  fallback_rate: number;
  sample_counts: { stored: number; dropped: number; pii_blocked: number };
  last_known_age_s: number | null;
  samples: Array<{
    sample_id: string;
    why: string;
    input_redacted: string;
    output_redacted: string;
  }>;
  next_cursor: string | null;
  truncated: boolean;
  report_url: string;
  live_traffic_changed: boolean;
  next_action: {
    tool: string | null;
    args: Record<string, unknown>;
    ask_human: string | null;
  };
};

describe("get_live_report (L7)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-live-report-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await buildApp({
      sqlitePath,
      apiKey,
      baseUrl: "http://test.local",
      openRouterClient: createMockOpenRouter(() => {
        throw new Error("get_live_report must not call OpenRouter");
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
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insertLastFull(extra?: Partial<UnsignedPolicy>): string {
    const db = openDb(sqlitePath);
    try {
      const signed = putPolicy(db, apiKey, sampleUnsigned(projectId, extra));
      const ok = promoteToLastFullIfNone(db, apiKey, projectId, signed.policy_id);
      assert.equal(ok, true);
      return signed.policy_id;
    } finally {
      db.close();
    }
  }

  function insertCanary(): string {
    const db = openDb(sqlitePath);
    try {
      const signed = putPolicy(
        db,
        apiKey,
        sampleUnsigned(projectId, {
          policy_id: newPolicyId(),
          version: 2,
          primary: { model_id: "openai/gpt-4.1", timeout_ms: 2500 },
        }),
      );
      const ok = activateCanary(db, apiKey, projectId, signed.policy_id);
      assert.equal(ok, true);
      return signed.policy_id;
    } finally {
      db.close();
    }
  }

  async function postStats(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/v1/runtime/stats",
      headers: authHeaders(),
      payload: body,
    });
  }

  async function postSample(extra?: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/v1/runtime/samples",
      headers: authHeaders(),
      payload: {
        sample_id: extra?.sample_id ?? newSampleId(),
        project_id: projectId,
        policy_id: extra?.policy_id ?? "pol_live_report",
        model_id: "openai/gpt-4.1-nano",
        why: extra?.why ?? "vendor_error",
        input_redacted: extra?.input_redacted ?? "Name the total.",
        output_redacted: extra?.output_redacted ?? "The vendor returned HTTP 503.",
        captured_at: extra?.captured_at ?? "2026-08-26T15:00:00.000Z",
        ...extra,
      },
    });
  }

  async function getReport(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/v1/tools/get_live_report",
      headers: authHeaders(),
      payload: body,
    });
  }

  it("returns 200 with last full pol_, canary off, intended 0, observed, fallback, sample count, report_url", async () => {
    const policyId = insertLastFull();
    const loadedAt = new Date(Date.now() - 12_000).toISOString();
    const stats = await postStats({
      project_id: projectId,
      hashed_request_count: 10,
      canary_request_count: 0,
      fallback_count: 1,
      request_count: 10,
      pii_blocked_count: 2,
      last_known_loaded_at: loadedAt,
    });
    assert.equal(stats.statusCode, 200);

    const ingested = await postSample({
      sample_id: newSampleId(),
      policy_id: policyId,
    });
    assert.equal(ingested.statusCode, 200);

    const res = await getReport({ project_id: projectId });
    assert.equal(res.statusCode, 200);
    const body = res.json() as LiveReportBody;
    const parsed = getLiveReportOutputSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed));

    assert.equal(body.policy_id, policyId);
    assert.equal(body.canary, false);
    assert.equal(body.intended_split, 0);
    assert.equal(body.observed_split, 0);
    assert.equal(body.fallback_rate, 0.1);
    assert.equal(body.sample_counts.stored, 1);
    assert.equal(body.sample_counts.dropped, 0);
    assert.equal(body.sample_counts.pii_blocked, 2);
    assert.ok(body.last_known_age_s !== null);
    assert.ok(body.last_known_age_s! >= 11);
    assert.ok(body.last_known_age_s! <= 14);
    assert.match(body.report_url, /^http:\/\/test\.local\/live-report\?token=/);
    assert.equal(body.live_traffic_changed, false);
    assert.equal(body.next_action.tool, "promote_live_sample");
    assert.equal(body.next_action.args.project_id, projectId);
    assert.ok(!("trace" in body));
  });

  it("returns canary on with intended 5 and observed from stored stats", async () => {
    insertLastFull();
    insertCanary();
    const stats = await postStats({
      project_id: projectId,
      hashed_request_count: 20,
      canary_request_count: 1,
      fallback_count: 2,
      request_count: 20,
    });
    assert.equal(stats.statusCode, 200);

    const res = await getReport({ project_id: projectId });
    assert.equal(res.statusCode, 200);
    const body = res.json() as LiveReportBody;
    assert.equal(body.canary, true);
    assert.equal(body.intended_split, 5);
    assert.equal(body.observed_split, 5);
    assert.equal(body.fallback_rate, 0.1);
    assert.equal(body.live_traffic_changed, false);
    assert.equal(body.next_action.tool, null);
  });

  it("paginates samples and rejects an extra field", async () => {
    insertLastFull();
    const ids = [newSampleId(), newSampleId(), newSampleId()];
    for (let i = 0; i < ids.length; i += 1) {
      const ingested = await postSample({
        sample_id: ids[i],
        captured_at: `2026-08-26T15:00:0${i}.000Z`,
        input_redacted: "x".repeat(200),
        output_redacted: "y".repeat(200),
      });
      assert.equal(ingested.statusCode, 200);
    }

    const page1 = await getReport({ project_id: projectId, limit: 2 });
    assert.equal(page1.statusCode, 200);
    const b1 = page1.json() as LiveReportBody;
    assert.equal(b1.samples.length, 2);
    assert.equal(b1.truncated, true);
    assert.ok(typeof b1.next_cursor === "string" && b1.next_cursor.length > 0);
    for (const sample of b1.samples) {
      assert.match(sample.sample_id, /^smp_/);
      assert.ok(sample.input_redacted.length <= 120);
      assert.ok(sample.output_redacted.length <= 120);
      assert.ok(!("trace" in sample));
    }
    assert.equal(b1.next_action.tool, "promote_live_sample");

    const page2 = await getReport({
      project_id: projectId,
      limit: 2,
      cursor: b1.next_cursor,
    });
    assert.equal(page2.statusCode, 200);
    const b2 = page2.json() as LiveReportBody;
    assert.equal(b2.samples.length, 1);
    assert.equal(b2.truncated, false);
    assert.equal(b2.next_cursor, null);
    const pageIds = [...b1.samples, ...b2.samples].map((s) => s.sample_id);
    assert.equal(new Set(pageIds).size, 3);

    const extra = await getReport({
      project_id: projectId,
      unexpected_field: true,
    });
    assert.equal(extra.statusCode, 400);
    assert.equal(isAgentError(extra.json()), true);
    assert.equal((extra.json() as { code: string }).code, ErrorCode.INVALID_INPUT);

    const parsed = parseToolInput("get_live_report", {
      project_id: projectId,
      unexpected_field: true,
    });
    assert.equal(parsed.ok, false);
  });

  it("serves HTML counts with HMAC and does not list samples", async () => {
    const policyId = insertLastFull();
    const sampleId = newSampleId();
    await postSample({ sample_id: sampleId, policy_id: policyId });
    await postStats({
      project_id: projectId,
      hashed_request_count: 4,
      canary_request_count: 0,
      fallback_count: 0,
      request_count: 4,
      pii_blocked_count: 1,
    });

    const report = await getReport({ project_id: projectId });
    const body = report.json() as LiveReportBody;
    const reportUrl = new URL(body.report_url);

    const html = await app.inject({
      method: "GET",
      url: `${reportUrl.pathname}${reportUrl.search}`,
    });
    assert.equal(html.statusCode, 200);
    assert.match(html.headers["content-type"] ?? "", /text\/html/);
    assert.match(html.body, /Live report/);
    assert.match(html.body, /This page shows counts only/);
    assert.match(html.body, new RegExp(policyId));
    assert.match(html.body, /Canary/);
    assert.match(html.body, /Intended split/);
    assert.match(html.body, /Observed split/);
    assert.match(html.body, /Fallback rate/);
    assert.match(html.body, /Samples stored/);
    assert.doesNotMatch(html.body, new RegExp(sampleId));
    assert.doesNotMatch(html.body, /\bdashboard\b/i);
    assert.doesNotMatch(html.body, /\btraffic explorer\b/i);
    assert.doesNotMatch(html.body, /\bshould\b/);
    assert.doesNotMatch(html.body, /\bcould\b/);
    assert.doesNotMatch(html.body, /\bmight\b/);

    const bad = await app.inject({
      method: "GET",
      url: "/live-report?token=nope",
    });
    assert.equal(bad.statusCode, 401);

    const missing = await app.inject({
      method: "GET",
      url: "/live-report",
    });
    assert.equal(missing.statusCode, 401);
  });

  it("lists the four Live tools on MCP with non-empty schemas", () => {
    const live = [
      "compile_policy",
      "get_live_report",
      "promote_live_sample",
      "propose_rollout",
    ] as const;
    for (const name of live) {
      const tool = MCP_TOOLS.find((t) => t.name === name);
      assert.ok(tool, `missing MCP tool ${name}`);
      assert.equal(typeof tool.description, "string");
      assert.ok(tool.description.length > 0);
      assert.doesNotMatch(tool.description, /^EvalRouter /);
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });

  it("sets live_traffic_changed false", async () => {
    insertLastFull();
    const res = await getReport({ project_id: projectId });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as LiveReportBody).live_traffic_changed, false);
  });

  it("returns 404 for an unknown project", async () => {
    const res = await getReport({ project_id: "prj_missing" });
    assert.equal(res.statusCode, 404);
    assert.equal(isAgentError(res.json()), true);
    const body = res.json() as { code: string };
    assert.equal(body.code, ErrorCode.PROJECT_NOT_FOUND);
  });

  it("counts dropped samples and does not list them", async () => {
    insertLastFull();
    const kept = newSampleId();
    const dropped = newSampleId();
    await postSample({ sample_id: kept });
    await postSample({ sample_id: dropped });
    const db = openDb(sqlitePath);
    try {
      assert.equal(dropSample(db, dropped), true);
    } finally {
      db.close();
    }

    const res = await getReport({ project_id: projectId });
    assert.equal(res.statusCode, 200);
    const body = res.json() as LiveReportBody;
    assert.equal(body.sample_counts.stored, 1);
    assert.equal(body.sample_counts.dropped, 1);
    assert.deepEqual(
      body.samples.map((s) => s.sample_id),
      [kept],
    );
  });
});
