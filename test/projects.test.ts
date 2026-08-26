import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiKey = "test-key-not-a-secret";

describe("POST /v1/projects", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-projects-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await buildApp({ sqlitePath, apiKey });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the SQLite file on boot", () => {
    assert.ok(existsSync(sqlitePath));
  });

  it("returns project_id with a Bearer key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { project_id?: unknown };
    assert.equal(typeof body.project_id, "string");
    assert.match(body.project_id as string, /^prj_[0-9a-f]+$/);
    assert.deepEqual(Object.keys(body), ["project_id"]);
    assert.ok(!JSON.stringify(body).includes(apiKey));
  });
});

describe("npm start", () => {
  it("creates SQLite on disk", { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "evalrouter-start-"));
    const sqlitePath = join(dir, "evalrouter.sqlite");
    const child = spawn("npm", ["start"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        EVALROUTER_KEY: apiKey,
        EVALROUTER_SQLITE: sqlitePath,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    try {
      await waitForFileOrExit(child, sqlitePath, 15_000);
      assert.ok(existsSync(sqlitePath));
    } catch (err) {
      throw new Error(
        `${(err as Error).message}${stderr ? `\nstderr:\n${stderr}` : ""}`,
      );
    } finally {
      child.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function waitForFileOrExit(
  child: ReturnType<typeof spawn>,
  path: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${path}`));
    }, timeoutMs);
    const interval = setInterval(() => {
      if (existsSync(path)) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve();
      }
    }, 50);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      clearInterval(interval);
      reject(new Error(`npm start exited code=${code} signal=${signal}`));
    });
  });
}
