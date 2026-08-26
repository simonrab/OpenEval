import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { newEvalSetId, newPolicyId, newRecId } from "../src/ids.js";
import {
  putPolicy,
  promoteToLastFullIfNone,
  signPolicy,
  verifyPolicy,
  type UnsignedPolicy,
} from "../src/policy.js";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";

const apiKey = "test-key-not-a-secret";

function authHeaders(key = apiKey): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

function sampleUnsigned(projectId: string): UnsignedPolicy {
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
  };
}

describe("newPolicyId", () => {
  it("uses the pol_ prefix", () => {
    assert.match(newPolicyId(), /^pol_[0-9a-f]+$/);
  });
});

describe("policy HMAC seal", () => {
  const unsigned = sampleUnsigned("prj_seal");

  it("verifies a good signature", () => {
    const signed = signPolicy(apiKey, unsigned);
    assert.match(signed.sig, /^hmac-sha256:[0-9a-f]{64}$/);
    assert.equal(verifyPolicy(apiKey, signed), true);
    assert.equal(signed.policy_id, unsigned.policy_id);
    assert.equal(signed.project_id, unsigned.project_id);
  });

  it("rejects a tampered body", () => {
    const signed = signPolicy(apiKey, unsigned);
    const tampered = {
      ...signed,
      primary: { ...signed.primary, model_id: "openai/gpt-4.1" },
    };
    assert.equal(verifyPolicy(apiKey, tampered), false);
  });

  it("rejects a tampered signature", () => {
    const signed = signPolicy(apiKey, unsigned);
    const last = signed.sig.slice(-1);
    const flipped = last === "a" ? "b" : "a";
    const tampered = { ...signed, sig: `${signed.sig.slice(0, -1)}${flipped}` };
    assert.equal(verifyPolicy(apiKey, tampered), false);
  });

  it("rejects the same bytes with a different apiKey", () => {
    const signed = signPolicy(apiKey, unsigned);
    assert.equal(verifyPolicy("other-key-not-a-secret", signed), false);
  });
});

describe("GET /v1/runtime/policies/:project_id", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let openRouterCalled = false;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-runtime-policy-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    openRouterCalled = false;
    const openRouterClient = createMockOpenRouter(() => {
      openRouterCalled = true;
      throw new Error("GET must not call OpenRouter");
    });
    const listModels = openRouterClient.listModels.bind(openRouterClient);
    const chatCompletion = openRouterClient.chatCompletion.bind(openRouterClient);
    app = await buildApp({
      sqlitePath,
      apiKey,
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

  function insertSignedPolicy(
    projectId: string,
    extra?: Partial<UnsignedPolicy>,
    asLastFull = true,
  ) {
    const db = openDb(sqlitePath);
    try {
      const signed = putPolicy(db, apiKey, { ...sampleUnsigned(projectId), ...extra });
      if (asLastFull) {
        promoteToLastFullIfNone(db, apiKey, projectId, signed.policy_id);
      }
      return signed;
    } finally {
      db.close();
    }
  }

  it("returns 200 with the signed document and an ETag", async () => {
    const projectId = await createProject();
    const stored = insertSignedPolicy(projectId);

    const res = await app.inject({
      method: "GET",
      url: `/v1/runtime/policies/${projectId}`,
      headers: authHeaders(),
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.policy_id, stored.policy_id);
    assert.equal(body.project_id, projectId);
    assert.equal(body.version, 1);
    assert.equal(body.previous_policy_id, null);
    assert.equal(body.rec_id, stored.rec_id);
    assert.equal(body.ste_id, stored.ste_id);
    assert.equal(body.compiled_at, stored.compiled_at);
    assert.deepEqual(body.primary, stored.primary);
    assert.deepEqual(body.backups, []);
    assert.equal(body.canary, null);
    assert.match(String(body.sig), /^hmac-sha256:[0-9a-f]{64}$/);
    assert.equal(verifyPolicy(apiKey, body as typeof stored), true);

    const hex = createHash("sha256").update(res.body, "utf8").digest("hex");
    assert.equal(res.headers.etag, `"${hex}"`);
    assert.equal(openRouterCalled, false);
  });

  it("returns 304 when If-None-Match matches the ETag", async () => {
    const projectId = await createProject();
    insertSignedPolicy(projectId);

    const first = await app.inject({
      method: "GET",
      url: `/v1/runtime/policies/${projectId}`,
      headers: authHeaders(),
    });
    assert.equal(first.statusCode, 200);
    const etag = first.headers.etag;
    assert.equal(typeof etag, "string");

    const second = await app.inject({
      method: "GET",
      url: `/v1/runtime/policies/${projectId}`,
      headers: {
        ...authHeaders(),
        "if-none-match": etag as string,
      },
    });
    assert.equal(second.statusCode, 304);
    assert.equal(second.body, "");
    assert.equal(openRouterCalled, false);
  });

  it("returns 401 when the Bearer key is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/runtime/policies/prj_missing",
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "unauthorized" });
  });

  it("returns 401 when the Bearer key is bad", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/runtime/policies/prj_missing",
      headers: authHeaders("wrong-key"),
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "unauthorized" });
  });

  it("returns 404 PROJECT_NOT_FOUND for an unknown project_id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/runtime/policies/prj_does_not_exist",
      headers: authHeaders(),
    });
    assert.equal(res.statusCode, 404);
    const body = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal((body as { code: string }).code, ErrorCode.PROJECT_NOT_FOUND);
    assert.ok((body as { next_action: unknown }).next_action);
  });

  it("returns 404 NO_LAST_KNOWN_POLICY when the project has no policy", async () => {
    const projectId = await createProject();
    const res = await app.inject({
      method: "GET",
      url: `/v1/runtime/policies/${projectId}`,
      headers: authHeaders(),
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as {
      code: string;
      message: string;
      retryable: boolean;
      next_action: { tool: string | null; ask_human: string | null };
    };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.NO_LAST_KNOWN_POLICY);
    assert.equal(typeof body.message, "string");
    assert.equal(body.message.includes("should"), false);
    assert.equal(body.message.includes("could"), false);
    assert.equal(body.message.includes("might"), false);
    assert.equal(body.retryable, false);
    assert.equal(body.next_action.tool, "compile_policy");
    assert.equal(body.next_action.ask_human, null);
    assert.equal(openRouterCalled, false);
  });

  it("returns last full policy, not a later draft", async () => {
    const projectId = await createProject();
    const first = insertSignedPolicy(projectId, {
      compiled_at: "2026-08-26T12:00:00.000Z",
      primary: { model_id: "openai/gpt-4.1-nano", timeout_ms: 2500 },
    });
    insertSignedPolicy(
      projectId,
      {
        compiled_at: "2026-08-26T13:00:00.000Z",
        primary: { model_id: "openai/gpt-4.1-mini", timeout_ms: 2500 },
      },
      false,
    );

    const res = await app.inject({
      method: "GET",
      url: `/v1/runtime/policies/${projectId}`,
      headers: authHeaders(),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { policy_id: string; primary: { model_id: string } };
    assert.equal(body.policy_id, first.policy_id);
    assert.equal(body.primary.model_id, "openai/gpt-4.1-nano");
  });

  it("does not serve an unsigned row", async () => {
    const projectId = await createProject();
    const db = openDb(sqlitePath);
    try {
      db.prepare(
        `INSERT INTO policies (id, project_id, body_json, etag, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        newPolicyId(),
        projectId,
        JSON.stringify({
          ...sampleUnsigned(projectId),
          sig: "",
        }),
        "not-a-real-etag",
        "2026-08-26T12:00:00.000Z",
      );
    } finally {
      db.close();
    }

    const res = await app.inject({
      method: "GET",
      url: `/v1/runtime/policies/${projectId}`,
      headers: authHeaders(),
    });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { code: string }).code, ErrorCode.NO_LAST_KNOWN_POLICY);
  });
});
