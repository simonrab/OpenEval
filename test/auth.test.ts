import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { hashKey, parseBearer } from "../src/auth.js";
import { buildApp } from "../src/server.js";

const apiKey = "test-key-not-a-secret";

describe("hashKey", () => {
  it("does not return the raw key", () => {
    assert.notEqual(hashKey("secret-key"), "secret-key");
  });

  it("is SHA-256 hex", () => {
    const expected = createHash("sha256").update("abc", "utf8").digest("hex");
    assert.equal(hashKey("abc"), expected);
    assert.match(hashKey("abc"), /^[0-9a-f]{64}$/);
  });
});

describe("parseBearer", () => {
  it("reads a Bearer token", () => {
    assert.equal(parseBearer("Bearer tok_123"), "tok_123");
  });

  it("returns null when the header is missing or not Bearer", () => {
    assert.equal(parseBearer(undefined), null);
    assert.equal(parseBearer("Basic tok_123"), null);
    assert.equal(parseBearer("Bearer"), null);
  });
});

describe("POST /v1/projects auth", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-auth-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await buildApp({ sqlitePath, apiKey });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 401 when the key is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    assert.equal(res.statusCode, 401);
  });

  it("returns 401 when the key is bad", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: {
        authorization: "Bearer wrong-key",
        "content-type": "application/json",
      },
      payload: {},
    });
    assert.equal(res.statusCode, 401);
  });

  it("stores a hash, not the raw key", () => {
    const db = new Database(sqlitePath, { readonly: true });
    const rows = db.prepare("SELECT key_hash FROM api_keys").all() as {
      key_hash: string;
    }[];
    db.close();
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.notEqual(row.key_hash, apiKey);
      assert.equal(row.key_hash, hashKey(apiKey));
    }
  });
});
