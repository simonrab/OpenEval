import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { deriveWrapKey, missingKeysRefError, readSecret } from "../src/keys.js";
import { buildApp } from "../src/server.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";

const apiKey = "test-key-not-a-secret";
const customerSecret = "sk-or-v1-slice2-secret-NEVER-LEAK";

const SECRET_FIELD_NAMES = ["secret", "api_key", "key", "raw", "plaintext"] as const;

function authHeaders(): { authorization: string; "content-type": string } {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

function assertNoSecretLeak(body: unknown, secret: string): void {
  const dumped = JSON.stringify(body);
  assert.ok(
    !dumped.includes(secret),
    `HTTP body must not include the customer secret: ${dumped}`,
  );
  if (body !== null && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    for (const name of SECRET_FIELD_NAMES) {
      if (name in rec) {
        assert.notEqual(rec[name], secret);
      }
    }
  }
}

async function createProject(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: authHeaders(),
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { project_id: string };
  return body.project_id;
}

describe("missing key on a later run path", () => {
  it("sets suggested_args.keys_ref", () => {
    const envelope = missingKeysRefError("prj_demo");
    assert.equal(isAgentError(envelope), true);
    assert.ok("keys_ref" in envelope.suggested_args);
    assert.equal(
      Object.prototype.hasOwnProperty.call(envelope.suggested_args, "keys_ref"),
      true,
    );
    assert.equal(envelope.next_action.tool, "run_evals");
  });
});

describe("POST /v1/keys", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-keys-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await buildApp({ sqlitePath, apiKey });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 401 without Bearer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { "content-type": "application/json" },
      payload: { project_id: "prj_x", secret: customerSecret },
    });
    assert.equal(res.statusCode, 401);
    assertNoSecretLeak(res.json(), customerSecret);
  });

  it("stores a key and returns keys_ref matching ^pkr_", async () => {
    const projectId = await createProject(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: authHeaders(),
      payload: { project_id: projectId, secret: customerSecret },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { keys_ref?: unknown };
    assert.equal(typeof body.keys_ref, "string");
    assert.match(body.keys_ref as string, /^pkr_/);
    assertNoSecretLeak(body, customerSecret);
  });

  it("returns PROJECT_NOT_FOUND for an unknown project_id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: authHeaders(),
      payload: { project_id: "prj_does_not_exist", secret: customerSecret },
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { code?: unknown };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.PROJECT_NOT_FOUND);
    assertNoSecretLeak(body, customerSecret);
  });

  it("does not store OPENROUTER_API_KEY from the server env", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "env-openrouter-must-not-be-used";
    try {
      const projectId = await createProject(app);
      const res = await app.inject({
        method: "POST",
        url: "/v1/keys",
        headers: authHeaders(),
        payload: { project_id: projectId, secret: customerSecret },
      });
      assert.equal(res.statusCode, 200);
      const db = new Database(sqlitePath, { readonly: true });
      const rows = db.prepare("SELECT * FROM keys_refs").all();
      db.close();
      const dumped = JSON.stringify(rows);
      assert.ok(!dumped.includes("env-openrouter-must-not-be-used"));
      assert.ok(!dumped.includes(customerSecret));
    } finally {
      if (previous === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previous;
      }
    }
  });
});

describe("GET /v1/keys/:id and project listing", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let keysRef: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-keys-get-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await buildApp({ sqlitePath, apiKey });
    projectId = await createProject(app);
    const created = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        secret: customerSecret,
        provider: "openrouter",
      },
    });
    assert.equal(created.statusCode, 200);
    keysRef = (created.json() as { keys_ref: string }).keys_ref;
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fetch by id never returns the secret in JSON", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/keys/${keysRef}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { keys_ref?: unknown };
    assert.equal(body.keys_ref, keysRef);
    assertNoSecretLeak(body, customerSecret);
    assert.ok(!res.body.includes(customerSecret));
  });

  it("GET without Bearer is 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/keys/${keysRef}`,
    });
    assert.equal(res.statusCode, 401);
    assert.ok(!res.body.includes(customerSecret));
  });

  it("shows the pkr_ on the project without the secret", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      project_id?: unknown;
      keys_refs?: unknown;
    };
    assert.equal(body.project_id, projectId);
    assert.ok(Array.isArray(body.keys_refs));
    assert.ok((body.keys_refs as string[]).includes(keysRef));
    assertNoSecretLeak(body, customerSecret);
  });

  it("GET project unknown id is PROJECT_NOT_FOUND", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_missing",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { code?: unknown };
    assert.equal(isAgentError(body), true);
    assert.equal(body.code, ErrorCode.PROJECT_NOT_FOUND);
  });

  it("sqlite row is not plaintext of the secret", () => {
    const db = new Database(sqlitePath, { readonly: true });
    const rows = db.prepare("SELECT * FROM keys_refs").all() as Record<
      string,
      unknown
    >[];
    db.close();
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      const dumped = JSON.stringify(row);
      assert.ok(!dumped.includes(customerSecret));
      for (const value of Object.values(row)) {
        if (typeof value === "string") {
          assert.notEqual(value, customerSecret);
        }
      }
    }
  });

  it("can decrypt internally without putting the secret on HTTP", () => {
    const wrapKey = deriveWrapKey(apiKey);
    const db = new Database(sqlitePath);
    const secret = readSecret(db, wrapKey, keysRef);
    db.close();
    assert.equal(secret, customerSecret);
  });
});
