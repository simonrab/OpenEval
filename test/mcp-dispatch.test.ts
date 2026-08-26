import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { callToolViaHttp } from "../src/mcp/server.js";
import { getMcpInputSchema, MCP_TOOLS } from "../src/mcp/tools.js";
import { parseToolInput, TOOL_NAMES } from "../src/tools/schema.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";
import {
  authHeaders,
  createTestApp,
  seedFiveTrustedEvals,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

const DEMO_DESCRIPTION = "Return JSON with `line_items[]` and `total_cents`.";

function assertEnvelope(body: unknown): asserts body is {
  code: string;
  message: string;
  retryable: boolean;
  next_action: {
    tool: string | null;
    args: Record<string, unknown>;
    ask_human: string | null;
  };
} {
  assert.equal(isAgentError(body), true);
}

function createInjectFetch(app: FastifyInstance): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = init?.headers;
    const headerRecord: Record<string, string> = {};
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        headerRecord[key] = value;
      });
    } else if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        headerRecord[key] = value;
      }
    } else if (headers) {
      Object.assign(headerRecord, headers);
    }

    const res = await app.inject({
      method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      url: `${parsed.pathname}${parsed.search}`,
      headers: headerRecord,
      payload:
        init?.body && typeof init.body === "string"
          ? JSON.parse(init.body)
          : undefined,
    });

    return new Response(res.body, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  };
}

function validInput(name: (typeof TOOL_NAMES)[number]): Record<string, unknown> {
  switch (name) {
    case "generate_eval_suite":
      return {
        description: DEMO_DESCRIPTION,
        idempotency_key: "idem-mcp-1",
      };
    case "queue_for_labeling":
      return {
        project_id: "prj_1",
        eval_set_id: "ste_1",
        idempotency_key: "idem-mcp-1",
      };
    case "get_label_status":
      return { project_id: "prj_1", eval_set_id: "ste_1" };
    case "run_evals":
      return {
        project_id: "prj_1",
        eval_set_id: "ste_1",
        max_eval_spend_usd: 2,
        idempotency_key: "idem-mcp-1",
      };
    case "recommend_models":
      return {
        project_id: "prj_1",
        eval_set_id: "ste_1",
        intent: "new_feature",
        idempotency_key: "idem-mcp-1",
      };
    case "register_failure":
      return {
        project_id: "prj_1",
        input: { prompt: "missing total_cents" },
        why_bad: "total_cents missing from JSON",
        idempotency_key: "idem-mcp-1",
      };
    case "get_eval_report":
      return { project_id: "prj_1", run_id: "run_1" };
    case "compile_policy":
      return {
        project_id: "prj_1",
        recommendation_id: "rec_1",
        eval_set_id: "ste_1",
        idempotency_key: "idem-mcp-1",
      };
  }
}

async function postViaHttp(
  app: FastifyInstance,
  name: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/tools/${name}`,
    headers: authHeaders(),
    payload: body,
  });
  return { status: res.statusCode, body: res.json() };
}

async function postViaMcpClient(
  app: FastifyInstance,
  name: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return callToolViaHttp(name, body, {
    baseUrl: "http://test.local",
    apiKey: TEST_API_KEY,
    fetch: createInjectFetch(app),
  });
}

describe("MCP tool registry", () => {
  it("registers v0 seven tools and compile_policy with non-empty schemas", () => {
    assert.equal(MCP_TOOLS.length, 8);
    const v0 = [
      "generate_eval_suite",
      "queue_for_labeling",
      "get_label_status",
      "run_evals",
      "recommend_models",
      "register_failure",
      "get_eval_report",
    ];
    for (const name of v0) {
      assert.ok(MCP_TOOLS.find((t) => t.name === name), `missing MCP tool ${name}`);
    }
    assert.ok(MCP_TOOLS.find((t) => t.name === "compile_policy"));
    for (const name of TOOL_NAMES) {
      const tool = MCP_TOOLS.find((t) => t.name === name);
      assert.ok(tool, `missing MCP tool ${name}`);
      assert.equal(typeof tool.description, "string");
      assert.ok(tool.description.length > 0);
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });
});

describe("MCP schema parity", () => {
  for (const name of TOOL_NAMES) {
    it(`${name} input schema is derived from the HTTP Zod schema`, () => {
      const mcpSchema = getMcpInputSchema(name);
      const tool = MCP_TOOLS.find((t) => t.name === name);
      assert.ok(tool);
      assert.deepEqual(mcpSchema, tool!.inputSchema);
      assert.equal(mcpSchema.additionalProperties, false);
      assert.equal(mcpSchema.type, "object");
    });
  }

  for (const name of TOOL_NAMES) {
    it(`${name} rejects extra fields in both HTTP and MCP schemas`, () => {
      const parsed = parseToolInput(name, {
        ...validInput(name),
        unexpected_field: true,
      });
      assert.equal(parsed.ok, false);
      assert.equal(mcpSchemaHasNoExtraProps(name), true);
    });
  }
});

function mcpSchemaHasNoExtraProps(name: (typeof TOOL_NAMES)[number]): boolean {
  const schema = getMcpInputSchema(name);
  return schema.additionalProperties === false;
}

describe("MCP HTTP client auth", () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-mcp-auth-"));
    app = await createTestApp(join(dir, "evalrouter.sqlite"));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends Bearer auth from EVALROUTER_KEY", async () => {
    let seenAuth: string | undefined;
    const fetchSpy: typeof fetch = async (_input, init) => {
      const headers = init?.headers;
      if (headers instanceof Headers) {
        seenAuth = headers.get("authorization") ?? undefined;
      } else if (headers && typeof headers === "object") {
        seenAuth =
          (headers as Record<string, string>).Authorization ??
          (headers as Record<string, string>).authorization;
      }
      return createInjectFetch(app)(_input, init);
    };

    await callToolViaHttp(
      "get_label_status",
      { project_id: "prj_1", eval_set_id: "ste_1" },
      {
        baseUrl: "http://test.local",
        apiKey: TEST_API_KEY,
        fetch: fetchSpy,
      },
    );
    assert.equal(seenAuth, `Bearer ${TEST_API_KEY}`);
  });

  it("returns 401 when the API key is missing", async () => {
    const result = await callToolViaHttp(
      "get_label_status",
      { project_id: "prj_1", eval_set_id: "ste_1" },
      {
        baseUrl: "http://test.local",
        apiKey: "wrong-key",
        fetch: createInjectFetch(app),
      },
    );
    assert.equal(result.status, 401);
  });
});

describe("MCP round-trip vs HTTP", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let keysRef: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-mcp-roundtrip-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await createTestApp(sqlitePath);

    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeaders(),
      payload: {},
    });
    assert.equal(proj.statusCode, 200);
    projectId = (proj.json() as { project_id: string }).project_id;

    const db = new Database(sqlitePath);
    const seeded = seedFiveTrustedEvals(db, projectId);
    evalSetId = seeded.evalSetId;
    keysRef = await storeCustomerKey(db, projectId);
    db.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("generate_eval_suite matches HTTP body and output", async () => {
    const body = {
      description: DEMO_DESCRIPTION,
      idempotency_key: "mcp-generate-1",
    };
    const http = await postViaHttp(app, "generate_eval_suite", body);
    const mcp = await postViaMcpClient(app, "generate_eval_suite", body);
    assert.equal(mcp.status, http.status);
    assert.deepEqual(mcp.body, http.body);
    assert.equal(http.status, 200);
  });

  it("run_evals matches HTTP body and output", async () => {
    const body = {
      project_id: projectId,
      eval_set_id: evalSetId,
      models: ["openai/gpt-4o-mini"],
      max_eval_spend_usd: 1,
      keys_ref: keysRef,
      idempotency_key: "mcp-run-1",
    };
    const http = await postViaHttp(app, "run_evals", body);
    const mcp = await postViaMcpClient(app, "run_evals", body);
    assert.equal(mcp.status, http.status);
    assert.deepEqual(mcp.body, http.body);
    assert.equal(http.status, 200);
  });

  it("get_eval_report matches HTTP body and output", async () => {
    const runRes = await postViaHttp(app, "run_evals", {
      project_id: projectId,
      eval_set_id: evalSetId,
      models: ["openai/gpt-4o-mini"],
      max_eval_spend_usd: 1,
      keys_ref: keysRef,
      idempotency_key: "mcp-run-report",
    });
    const runId = (runRes.body as { run_id: string }).run_id;
    await waitForRunComplete(app, projectId, runId);

    const body = { project_id: projectId, run_id: runId };
    const http = await postViaHttp(app, "get_eval_report", body);
    const mcp = await postViaMcpClient(app, "get_eval_report", body);
    assert.equal(mcp.status, http.status);
    assert.deepEqual(mcp.body, http.body);
    assert.equal(http.status, 200);
  });

  it("recommend_models matches HTTP body and output", async () => {
    const runRes = await postViaHttp(app, "run_evals", {
      project_id: projectId,
      eval_set_id: evalSetId,
      models: ["openai/gpt-4o-mini", "google/gemini-flash-1.5"],
      max_eval_spend_usd: 5,
      keys_ref: keysRef,
      idempotency_key: "mcp-run-recommend",
    });
    const runId = (runRes.body as { run_id: string }).run_id;
    await waitForRunComplete(app, projectId, runId);

    const body = {
      project_id: projectId,
      eval_set_id: evalSetId,
      run_id: runId,
      intent: "new_feature" as const,
      idempotency_key: "mcp-recommend-1",
    };
    const http = await postViaHttp(app, "recommend_models", body);
    const mcp = await postViaMcpClient(app, "recommend_models", body);
    assert.equal(mcp.status, http.status);
    assert.deepEqual(mcp.body, http.body);
    assert.equal(http.status, 200);
  });
});

describe("MCP unknown tools", () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-mcp-envelope-"));
    app = await createTestApp(join(dir, "evalrouter.sqlite"));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("unknown tool returns 404 envelope over MCP client", async () => {
    const http = await postViaHttp(app, "not_a_real_tool", {});
    const mcp = await postViaMcpClient(app, "not_a_real_tool", {});
    assert.equal(mcp.status, http.status);
    assert.deepEqual(mcp.body, http.body);
    assert.equal(mcp.status, 404);
    assertEnvelope(mcp.body);
    assert.equal(mcp.body.code, ErrorCode.UNKNOWN_TOOL);
  });
});
