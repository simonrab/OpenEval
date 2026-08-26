import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { deriveWrapKey, storeKey } from "../../src/keys.js";
import { createEvalSetVersion1, type DraftEval } from "../../src/eval-set.js";
import { newJobId } from "../../src/ids.js";
import { createMockOpenRouter } from "../../src/runner/openrouter.js";
import { buildApp } from "../../src/server.js";

export const TEST_API_KEY = "test-key-not-a-secret";
export const CUSTOMER_SECRET = "sk-or-v1-test-customer-key";

export function authHeaders(): {
  authorization: string;
  "content-type": string;
} {
  return {
    authorization: `Bearer ${TEST_API_KEY}`,
    "content-type": "application/json",
  };
}

export function acceptToken(evalSetId: string): string {
  return createHmac("sha256", TEST_API_KEY)
    .update(`accept:${evalSetId}`)
    .digest("hex");
}

const GOOD_JSON =
  '{"line_items":[{"sku":"a","qty":1}],"total_cents":100}';

export function fiveCodeDrafts(): DraftEval[] {
  const input = "Return JSON with line_items[] and total_cents.";
  return [
    {
      title: "Output is valid JSON",
      score_how: "code",
      status: "draft",
      program_check: { kind: "json_valid", expected: true },
      input_truncated: input,
    },
    {
      title: "JSON has line_items[]",
      score_how: "code",
      status: "draft",
      program_check: {
        kind: "field_equals",
        expected: { path: "line_items", exists: true, type: "array" },
      },
      input_truncated: input,
    },
    {
      title: "JSON has total_cents",
      score_how: "code",
      status: "draft",
      program_check: {
        kind: "field_equals",
        expected: { path: "total_cents", exists: true },
      },
      input_truncated: input,
    },
    {
      title: "Must not wrap JSON in markdown",
      score_how: "code",
      status: "draft",
      program_check: { kind: "must_not_contain", expected: "```" },
      input_truncated: input,
    },
    {
      title: "total_cents is numeric",
      score_how: "code",
      status: "draft",
      program_check: {
        kind: "field_equals",
        expected: { path: "total_cents", exists: true, type: "number" },
      },
      input_truncated: input,
    },
  ];
}

export function seedFiveTrustedEvals(
  db: Database.Database,
  projectId: string,
): { evalSetId: string; evalIds: string[] } {
  const jobId = newJobId();
  db.prepare(
    `INSERT INTO jobs (id, project_id, description, limits, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
  ).run(jobId, projectId, "JSON invoice job", new Date().toISOString());

  const created = createEvalSetVersion1(db, {
    projectId,
    jobId,
    drafts: fiveCodeDrafts(),
  });

  const trust = db.prepare(
    `UPDATE evals SET status = 'trusted' WHERE id = ? AND score_how = 'code'`,
  );
  for (const ev of created.evals) {
    trust.run(ev.eval_id);
  }

  return {
    evalSetId: created.evalSetId,
    evalIds: created.evals.map((e) => e.eval_id),
  };
}

export async function createTestApp(
  sqlitePath: string,
  costPerCall = 0.05,
): Promise<FastifyInstance> {
  return buildApp({
    sqlitePath,
    apiKey: TEST_API_KEY,
    baseUrl: "http://test.local",
    openRouterClient: createMockOpenRouter({
      "*": GOOD_JSON,
    }, costPerCall),
  });
}

export async function storeCustomerKey(
  db: Database.Database,
  projectId: string,
): Promise<string> {
  const wrapKey = deriveWrapKey(TEST_API_KEY);
  return storeKey(db, wrapKey, {
    projectId,
    secret: CUSTOMER_SECRET,
    provider: "openrouter",
  });
}

export async function waitForRunComplete(
  app: FastifyInstance,
  projectId: string,
  runId: string,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/get_eval_report",
      headers: authHeaders(),
      payload: { project_id: projectId, run_id: runId },
    });
    const body = res.json() as { status?: string };
    if (
      body.status === "succeeded" ||
      body.status === "partial" ||
      body.status === "failed"
    ) {
      return body as Record<string, unknown>;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`);
}
