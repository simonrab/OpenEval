import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import {
  generateEvalSuiteOutputSchema,
} from "../src/tools/schema.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";

const apiKey = "test-key-not-a-secret";

const DEMO_DESCRIPTION = "Return JSON with `line_items[]` and `total_cents`.";

type GenerateSuccess = {
  project_id: string;
  job_id: string;
  eval_set_id: string;
  version: number;
  evals: Array<{
    eval_id: string;
    title: string;
    score_how: "code" | "person";
    status: string;
  }>;
  n_code: number;
  n_person: number;
  n_draft: number;
  counts: {
    draft: number;
    code: number;
    needs_person: number;
    trusted: number;
    total: number;
  };
  mark_url: string | null;
  next_action: {
    tool: string | null;
    args: Record<string, unknown>;
    ask_human: string | null;
  };
};

function authHeaders(): { authorization: string; "content-type": string } {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

async function postGenerate(
  app: FastifyInstance,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/v1/tools/generate_eval_suite",
    headers: authHeaders(),
    payload,
  });
}

describe("generate_eval_suite (J1)", () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-generate-"));
    app = await buildApp({
      sqlitePath: join(dir, "evalrouter.sqlite"),
      apiKey,
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("JSON-object job returns ste_, draft evals, counts, and next_action", async () => {
    const res = await postGenerate(app, {
      description: DEMO_DESCRIPTION,
      idempotency_key: "idem-json-1",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as GenerateSuccess;
    const parsed = generateEvalSuiteOutputSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed));

    assert.match(body.project_id, /^prj_/);
    assert.match(body.job_id, /^job_/);
    assert.match(body.eval_set_id, /^ste_/);
    assert.equal(body.version, 1);
    assert.ok(body.evals.length >= 1);
    assert.ok(body.evals.length <= 5);
    for (const ev of body.evals) {
      assert.match(ev.eval_id, /^cas_/);
      assert.equal(ev.status, "draft");
    }
    assert.ok(body.n_code + body.n_person >= 1);
    assert.equal(body.n_draft, body.counts.draft);
    assert.equal(body.n_code, body.counts.code);
    assert.equal(body.n_person, body.counts.needs_person);
    assert.equal(body.counts.trusted, 0);
    assert.equal(body.counts.total, body.n_code + body.n_person);
    assert.equal(body.n_draft, body.counts.total);
    assert.ok("mark_url" in body);
    assert.ok(body.next_action);
    assert.ok("tool" in body.next_action);
    if (body.n_person === 0) {
      assert.equal(body.next_action.tool, "run_evals");
      assert.equal(body.mark_url, null);
    } else {
      assert.equal(body.next_action.tool, "queue_for_labeling");
    }
  });

  it("creates a project when project_id is omitted", async () => {
    const res = await postGenerate(app, {
      description: DEMO_DESCRIPTION,
      idempotency_key: "idem-no-project",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as GenerateSuccess;
    assert.match(body.project_id, /^prj_/);
  });

  it("returns PROJECT_NOT_FOUND for a missing project_id", async () => {
    const res = await postGenerate(app, {
      project_id: "prj_does_not_exist",
      description: DEMO_DESCRIPTION,
      idempotency_key: "idem-missing-project",
    });
    assert.equal(res.statusCode, 404);
    const body: unknown = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal((body as { code: string }).code, ErrorCode.PROJECT_NOT_FOUND);
  });

  it("vague description returns JOB_UNCLEAR and ask_human what good means", async () => {
    const res = await postGenerate(app, {
      description: "make the feature nicer for users",
      idempotency_key: "idem-vague",
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500);
    const body: unknown = res.json();
    assert.equal(isAgentError(body), true);
    const envelope = body as {
      code: string;
      next_action: { tool: string | null; ask_human: string | null };
    };
    assert.equal(envelope.code, ErrorCode.JOB_UNCLEAR);
    assert.equal(envelope.next_action.tool, null);
    assert.equal(envelope.next_action.ask_human, "what good means");
  });

  it("what_good_means after JOB_UNCLEAR writes draft checks that are not trusted", async () => {
    const unclear = await postGenerate(app, {
      description: "a helpful assistant",
      idempotency_key: "idem-unclear-first",
    });
    assert.equal((unclear.json() as { code: string }).code, ErrorCode.JOB_UNCLEAR);

    const res = await postGenerate(app, {
      description: "a helpful assistant",
      what_good_means: {
        how_it_should_behave: "return a JSON object",
        success: "includes a total field",
        must_never: "return markdown fences",
      },
      idempotency_key: "idem-after-good-means",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as GenerateSuccess;
    assert.equal(generateEvalSuiteOutputSchema.safeParse(body).success, true);
    assert.ok(body.evals.length >= 1);
    for (const ev of body.evals) {
      assert.equal(ev.status, "draft");
      assert.notEqual(ev.status, "trusted");
    }
    assert.equal(body.counts.trusted, 0);
    assert.equal(body.n_draft, body.counts.total);
    assert.ok(body.n_draft >= 1);
  });

  it("same idempotency_key returns the same ste_ and cas_ ids", async () => {
    const payload = {
      description: DEMO_DESCRIPTION,
      idempotency_key: "idem-same-key",
    };
    const first = await postGenerate(app, payload);
    assert.equal(first.statusCode, 200);
    const a = first.json() as GenerateSuccess;
    const second = await postGenerate(app, payload);
    assert.equal(second.statusCode, 200);
    const b = second.json() as GenerateSuccess;
    assert.equal(b.eval_set_id, a.eval_set_id);
    assert.equal(b.job_id, a.job_id);
    assert.equal(b.project_id, a.project_id);
    assert.deepEqual(
      b.evals.map((e) => e.eval_id),
      a.evals.map((e) => e.eval_id),
    );
  });

  it("intent add_feature requires eval_set_id at the API layer", async () => {
    const res = await postGenerate(app, {
      description: DEMO_DESCRIPTION,
      intent: "add_feature",
      idempotency_key: "idem-add-no-ste",
    });
    assert.notEqual(res.statusCode, 200);
    const body: unknown = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal((body as { code: string }).code, ErrorCode.INVALID_INPUT);
  });

  it("sample_files become extra draft evals", async () => {
    const res = await postGenerate(app, {
      description: DEMO_DESCRIPTION,
      sample_files: [
        {
          path: "fixtures/inv-001.json",
          content: '{"line_items":[],"total_cents":0}',
        },
      ],
      idempotency_key: "idem-samples",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as GenerateSuccess;
    assert.ok(body.counts.total >= 2);
  });
});
