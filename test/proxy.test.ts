import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { newEvalSetId, newPolicyId, newRecId } from "../src/ids.js";
import { createLiveSdk } from "../src/live/sdk.js";
import { stickyBucket } from "../src/live/sticky.js";
import {
  activateCanary,
  promoteToLastFullIfNone,
  putPolicy,
  type UnsignedPolicy,
} from "../src/policy.js";
import { createMockOpenRouter } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";

const apiKey = "test-key-not-a-secret";
const vendorKey = "sk-or-v1-test-vendor";
const lastFullModel = "openai/gpt-4.1-mini";
const canaryModel = "anthropic/claude-3-haiku";

function authHeaders(projectId: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "x-evalrouter-project-id": projectId,
    "x-openrouter-api-key": vendorKey,
  };
}

function canaryUser(): string {
  for (let i = 0; i < 10_000; i += 1) {
    const id = `user-${i}`;
    if (stickyBucket(id) < 5) {
      return id;
    }
  }
  throw new Error("no canary user found");
}

function policy(projectId: string, modelId: string, version: number): UnsignedPolicy {
  return {
    policy_id: newPolicyId(),
    version,
    previous_policy_id: null,
    project_id: projectId,
    rec_id: newRecId(),
    ste_id: newEvalSetId(),
    compiled_at: new Date().toISOString(),
    primary: { model_id: modelId, timeout_ms: 2500 },
    backups: [],
    canary: null,
  };
}

describe("optional proxy runtime", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let proxyModel: string | null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-proxy-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    proxyModel = null;
    app = await buildApp({
      sqlitePath,
      apiKey,
      baseUrl: "http://test.local",
      openRouterClient: createMockOpenRouter((model) => {
        proxyModel = model;
        return { content: "hello world", time_ms: 1, cost_usd: 0 };
      }),
    });
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {},
    });
    assert.equal(project.statusCode, 200);
    projectId = (project.json() as { project_id: string }).project_id;
    seedRuntimePolicies();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedRuntimePolicies(): void {
    const db = openDb(sqlitePath);
    try {
      const last = putPolicy(db, apiKey, policy(projectId, lastFullModel, 1));
      assert.equal(
        promoteToLastFullIfNone(db, apiKey, projectId, last.policy_id),
        true,
      );
      const canary = putPolicy(db, apiKey, policy(projectId, canaryModel, 2));
      assert.equal(activateCanary(db, apiKey, projectId, canary.policy_id), true);
    } finally {
      db.close();
    }
  }

  it("streams OpenAI-compatible SSE chunks", async () => {
    const user = canaryUser();
    const res = await app.inject({
      method: "POST",
      url: "/v1/proxy/chat/completions",
      headers: authHeaders(projectId),
      payload: {
        messages: [{ role: "user", content: "Say hello." }],
        user,
        stream: true,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);
    assert.match(res.body, /data: /);
    assert.match(res.body, /hello/);
    assert.match(res.body, /world/);
    assert.match(res.body, /data: \[DONE\]/);
    assert.equal(proxyModel, canaryModel);
  });

  it("proxy and SDK choose the same sticky policy", async () => {
    const user = canaryUser();
    let sdkModel: string | null = null;
    const sdk = createLiveSdk({
      projectId,
      evalrouterUrl: "http://test.local",
      evalrouterKey: apiKey,
      vendorKey,
      lastKnownPath: join(dir, "last-known.json"),
      pollMs: 30_000,
      fetch: (async (input, init): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.startsWith("https://openrouter.ai/")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
          sdkModel = body.model;
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "sdk" } }] }),
            { status: 200 },
          );
        }
        if (url.includes("/v1/runtime/policies/")) {
          const injected = await app.inject({
            method: "GET",
            url: `/v1/runtime/policies/${projectId}`,
            headers: { authorization: `Bearer ${apiKey}` },
          });
          return new Response(injected.body, {
            status: injected.statusCode,
            headers: injected.headers as Record<string, string>,
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });
    await sdk.start();
    await sdk.complete({ prompt: "Say hello.", user_id: user });
    sdk.stop();

    const proxy = await app.inject({
      method: "POST",
      url: "/v1/proxy/chat/completions",
      headers: authHeaders(projectId),
      payload: {
        messages: [{ role: "user", content: "Say hello." }],
        user,
      },
    });
    assert.equal(proxy.statusCode, 200);
    assert.equal(sdkModel, canaryModel);
    assert.equal(proxyModel, sdkModel);
  });
});

