import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { INPUT_TRUNCATE } from "../src/eval-set.js";
import { openDb } from "../src/db.js";
import { newEvalSetId, newPolicyId, newRecId, newSampleId } from "../src/ids.js";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
import { putPolicy } from "../src/policy.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";

const apiKey = "test-key-not-a-secret";

function authHeaders(key = apiKey): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

describe("newSampleId", () => {
  it("uses the smp_ prefix", () => {
    assert.match(newSampleId(), /^smp_[0-9a-f]+$/);
  });
});

describe("POST /v1/runtime/samples", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-live-samples-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await buildApp({
      sqlitePath,
      apiKey,
      openRouterClient: createMockOpenRouter(() => {
        throw new Error("sample ingest must not call OpenRouter");
      }),
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function createProject(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    return (res.json() as { project_id: string }).project_id;
  }

  function samplePayload(
    projectId: string,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    const policyId =
      typeof extra?.policy_id === "string"
        ? extra.policy_id
        : projectId === "prj_missing"
          ? "pol_live_sample_1"
          : seedPolicy(projectId);
    return {
      sample_id: extra?.sample_id ?? newSampleId(),
      project_id: projectId,
      policy_id: policyId,
      model_id: "openai/gpt-4.1-nano",
      why: "vendor_error",
      input_redacted: "Name the total.",
      output_redacted: "The vendor returned HTTP 503.",
      captured_at: "2026-08-26T15:00:00.000Z",
      ...extra,
    };
  }

  function seedPolicy(projectId: string): string {
    const db = openDb(sqlitePath);
    try {
      const signed = putPolicy(db, apiKey, {
        policy_id: newPolicyId(),
        version: 1,
        previous_policy_id: null,
        project_id: projectId,
        rec_id: newRecId(),
        ste_id: newEvalSetId(),
        compiled_at: "2026-08-26T12:00:00.000Z",
        primary: { model_id: "openai/gpt-4.1-nano", timeout_ms: 2500 },
        backups: [],
        canary: null,
      });
      return signed.policy_id;
    } finally {
      db.close();
    }
  }

  it("returns 401 when the Bearer key is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/runtime/samples",
      headers: { "content-type": "application/json" },
      payload: samplePayload("prj_missing"),
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "unauthorized" });
  });

  it("returns 401 when the Bearer key is bad", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/runtime/samples",
      headers: {
        ...authHeaders("wrong-key"),
        "content-type": "application/json",
      },
      payload: samplePayload("prj_missing"),
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "unauthorized" });
  });

  it("stores a redacted sample with an smp_ id and truncated fields", async () => {
    const projectId = await createProject();
    const longInput = `Prompt ${"x".repeat(600)}`;
    const longOutput = `Error ${"y".repeat(600)}`;
    const sampleId = newSampleId();
    const policyId = seedPolicy(projectId);
    const res = await app.inject({
      method: "POST",
      url: "/v1/runtime/samples",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      payload: samplePayload(projectId, {
        sample_id: sampleId,
        policy_id: policyId,
        input_redacted: longInput,
        output_redacted: longOutput,
      }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { sample_id: string };
    assert.equal(body.sample_id, sampleId);
    assert.match(body.sample_id, /^smp_/);

    const db = openDb(sqlitePath);
    try {
      const row = db
        .prepare(
          `SELECT id, project_id, policy_id, model_id, why,
                  input_redacted, output_redacted, captured_at
           FROM samples WHERE id = ?`,
        )
        .get(sampleId) as {
        id: string;
        project_id: string;
        policy_id: string;
        model_id: string;
        why: string;
        input_redacted: string;
        output_redacted: string;
        captured_at: string;
      };
      assert.equal(row.id, sampleId);
      assert.equal(row.project_id, projectId);
      assert.equal(row.policy_id, policyId);
      assert.equal(row.model_id, "openai/gpt-4.1-nano");
      assert.equal(row.why, "vendor_error");
      assert.equal(row.input_redacted.length <= INPUT_TRUNCATE, true);
      assert.equal(row.output_redacted.length <= INPUT_TRUNCATE, true);
      assert.equal(row.input_redacted.startsWith("Prompt "), true);
      assert.equal(row.captured_at, "2026-08-26T15:00:00.000Z");
    } finally {
      db.close();
    }
  });

  it("redacts secrets before persist", async () => {
    const projectId = await createProject();
    const secret = "sk-or-v1-persist-me-not-please";
    const res = await app.inject({
      method: "POST",
      url: "/v1/runtime/samples",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      payload: samplePayload(projectId, {
        input_redacted: `Key ${secret}`,
      }),
    });
    assert.equal(res.statusCode, 200);
    const sampleId = (res.json() as { sample_id: string }).sample_id;
    const db = openDb(sqlitePath);
    try {
      const row = db
        .prepare("SELECT input_redacted FROM samples WHERE id = ?")
        .get(sampleId) as { input_redacted: string };
      assert.equal(row.input_redacted.includes(secret), false);
      assert.equal(row.input_redacted.includes("Key"), true);
    } finally {
      db.close();
    }
  });

  it("hashes email, phone, and card-like numbers before persist", async () => {
    const projectId = await createProject();
    const email = "payer@example.com";
    const phone = "415-555-0199";
    const card = "4111111111111111";
    const res = await app.inject({
      method: "POST",
      url: "/v1/runtime/samples",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      payload: samplePayload(projectId, {
        input_redacted: `Bill ${email} ${phone} ${card}`,
        why: "app_reported",
      }),
    });
    assert.equal(res.statusCode, 200);
    const sampleId = (res.json() as { sample_id: string }).sample_id;
    const db = openDb(sqlitePath);
    try {
      const row = db
        .prepare("SELECT input_redacted, why FROM samples WHERE id = ?")
        .get(sampleId) as { input_redacted: string; why: string };
      assert.equal(row.why, "app_reported");
      assert.equal(row.input_redacted.includes(email), false);
      assert.equal(row.input_redacted.includes(phone), false);
      assert.equal(row.input_redacted.includes(card), false);
      assert.equal(row.input_redacted.includes("Bill"), true);
    } finally {
      db.close();
    }
  });

  it("returns PII_BLOCKED and stores no row when the example is not safe", async () => {
    const projectId = await createProject();
    const ssn = "123-45-6789";
    const res = await app.inject({
      method: "POST",
      url: "/v1/runtime/samples",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      payload: samplePayload(projectId, {
        input_redacted: `SSN ${ssn}`,
      }),
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string; message: string };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.PII_BLOCKED);
    assert.equal(typeof body.message, "string");
    assert.equal(body.message.includes("should"), false);
    assert.equal(body.message.includes("could"), false);
    assert.equal(body.message.includes("might"), false);

    const db = openDb(sqlitePath);
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM samples").get() as {
        n: number;
      };
      assert.equal(row.n, 0);
      const dump = db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'samples'")
        .get() as { sql: string };
      assert.equal(typeof dump.sql, "string");
    } finally {
      db.close();
    }
  });

  it("rejects a policy_id from another project", async () => {
    const projectId = await createProject();
    const otherProjectId = await createProject();
    const otherPolicyId = seedPolicy(otherProjectId);
    const res = await app.inject({
      method: "POST",
      url: "/v1/runtime/samples",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      payload: samplePayload(projectId, {
        policy_id: otherPolicyId,
      }),
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string; message: string };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.INVALID_INPUT);
    assert.equal(body.message.includes("policy_id"), true);
  });
});
