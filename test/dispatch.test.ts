import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { dispatch, handlers } from "../src/dispatch.js";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { TOOL_NAMES } from "../src/tools/schema.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";

const apiKey = "test-key-not-a-secret";

function authHeaders(): { authorization: string; "content-type": string } {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

function assertEnvelope(body: unknown): asserts body is {
  code: string;
  message: string;
  retryable: boolean;
  suggested_tool: string | null;
  suggested_args: Record<string, unknown>;
  next_action: {
    tool: string | null;
    args: Record<string, unknown>;
    ask_human: string | null;
  };
} {
  assert.equal(isAgentError(body), true);
  const envelope = body as {
    code: string;
    message: string;
    retryable: boolean;
    suggested_tool: string | null;
    suggested_args: Record<string, unknown>;
    next_action: {
      tool: string | null;
      args: Record<string, unknown>;
      ask_human: string | null;
    };
  };
  assert.equal(typeof envelope.code, "string");
  assert.equal(typeof envelope.message, "string");
  assert.equal(typeof envelope.retryable, "boolean");
  assert.ok("suggested_tool" in envelope);
  assert.equal(typeof envelope.suggested_args, "object");
  assert.ok(envelope.next_action);
  assert.ok("tool" in envelope.next_action);
  assert.ok("args" in envelope.next_action);
  assert.ok("ask_human" in envelope.next_action);
}

describe("dispatch registry", () => {
  it("registers all seven tools", () => {
    for (const name of TOOL_NAMES) {
      assert.ok(handlers.has(name), `missing handler for ${name}`);
    }
  });

  it("returns UNKNOWN_TOOL for an unknown name", async () => {
    const result = await dispatch("not_a_real_tool", {});
    assert.equal(result.status, 404);
    assertEnvelope(result.body);
    assert.equal(result.body.code, ErrorCode.UNKNOWN_TOOL);
  });

  it("returns an error envelope for run_evals without a valid project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evalrouter-dispatch-"));
    const db = openDb(join(dir, "evalrouter.sqlite"));
    try {
      const result = await dispatch(
        "run_evals",
        {
          project_id: "prj_1",
          eval_set_id: "ste_1",
          max_eval_spend_usd: 2,
          keys_ref: "pkr_1",
          idempotency_key: "idem-1",
        },
        { db },
      );
      assert.notEqual(result.status, 500);
      assertEnvelope(result.body);
      assert.equal(result.body.code, ErrorCode.PROJECT_NOT_FOUND);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects extra input fields before calling a handler", async () => {
    const result = await dispatch("generate_eval_suite", {
      description: "Invoice image → JSON line items",
      idempotency_key: "idem-1",
      unexpected_field: true,
    });
    assert.equal(result.status, 400);
    assertEnvelope(result.body);
    assert.equal(result.body.code, ErrorCode.INVALID_INPUT);
  });

  it("rejects a mutating call without idempotency_key", async () => {
    const result = await dispatch("run_evals", {
      project_id: "prj_1",
      eval_set_id: "ste_1",
      max_eval_spend_usd: 2,
    });
    assert.equal(result.status, 400);
    assertEnvelope(result.body);
    assert.equal(result.body.code, ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
  });
});

describe("POST /v1/tools/:name", () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-tools-"));
    app = await buildApp({
      sqlitePath: join(dir, "evalrouter.sqlite"),
      apiKey,
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 401 when the key is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    assert.equal(res.statusCode, 401);
  });

  it("returns 404 with next_action for an unknown name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/not_a_real_tool",
      headers: authHeaders(),
      payload: {},
    });
    assert.equal(res.statusCode, 404);
    const body: unknown = res.json();
    assertEnvelope(body);
    assert.equal(body.code, ErrorCode.UNKNOWN_TOOL);
  });

  it("fails closed when generate_eval_suite has an extra field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "Invoice image → JSON line items",
        idempotency_key: "idem-1",
        unexpected_field: true,
      },
    });
    assert.equal(res.statusCode, 400);
    const body: unknown = res.json();
    assertEnvelope(body);
    assert.equal(body.code, ErrorCode.INVALID_INPUT);
  });

  it("returns an error envelope for run_evals without keys_ref", async () => {
    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeaders(),
      payload: {},
    });
    const projectId = (proj.json() as { project_id: string }).project_id;

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: "ste_1",
        max_eval_spend_usd: 2,
        idempotency_key: "idem-1",
      },
    });
    assert.notEqual(res.statusCode, 500);
    const body: unknown = res.json();
    assertEnvelope(body);
    assert.equal(body.code, ErrorCode.INVALID_INPUT);
    assert.ok(body.next_action);
  });

  it("rejects a mutating call without idempotency_key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: { description: "Invoice image → JSON line items" },
    });
    assert.equal(res.statusCode, 400);
    const body: unknown = res.json();
    assertEnvelope(body);
    assert.equal(body.code, ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
  });

  it("does not require idempotency_key on get_label_status", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/get_label_status",
      headers: authHeaders(),
      payload: { project_id: "prj_1", eval_set_id: "ste_1" },
    });
    assert.notEqual(res.statusCode, 400);
    const body: unknown = res.json();
    assertEnvelope(body);
    assert.equal(body.code, ErrorCode.PROJECT_NOT_FOUND);
  });

  it("keeps POST /v1/projects working", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeaders(),
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { project_id?: string };
    assert.match(body.project_id ?? "", /^prj_/);
  });
});
