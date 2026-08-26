import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { signMarkToken } from "../src/mark/tokens.js";
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
  accept_url: string | null;
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
  let sqlitePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-generate-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await buildApp({
      sqlitePath,
      apiKey,
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("JSON-object job returns enough code drafts, accept_url, counts, and next_action", async () => {
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
    assert.equal(body.n_person, 0);
    assert.ok(body.n_code >= 5);
    assert.ok(body.accept_url);
    assert.match(body.accept_url!, /\/accept\?eval_set_id=ste_/);
    assert.match(body.accept_url!, /token=/);
    assert.ok("mark_url" in body);
    assert.equal(body.mark_url, null);
    assert.ok(body.next_action);
    assert.ok("tool" in body.next_action);
    assert.equal(body.next_action.tool, null);
    assert.equal(body.next_action.ask_human, "open accept_url");
    assert.equal(body.next_action.args.accept_url, body.accept_url);
    assert.equal(body.next_action.args.after_accept_tool, "run_evals");
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

  it("unstructured PDF invoice extract returns JOB_UNCLEAR not a JSON suite", async () => {
    const res = await postGenerate(app, {
      description: "Extract fields from PDF invoices without a fixed schema",
      idempotency_key: "idem-pdf-invoice",
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500);
    const body: unknown = res.json();
    assert.equal(isAgentError(body), true);
    assert.equal((body as { code: string }).code, ErrorCode.JOB_UNCLEAR);
  });

  it("mixed JSON plus tone yields code and person drafts", async () => {
    const res = await postGenerate(app, {
      description: "Return JSON with line_items and a warm friendly tone",
      idempotency_key: "idem-mixed-tone",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as GenerateSuccess;
    assert.ok(body.n_code > 0);
    assert.ok(body.n_person > 0);
    assert.equal(body.next_action.args.after_accept_tool, "queue_for_labeling");
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

  it("attaches a PNG sample file to person evals", async () => {
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const res = await postGenerate(app, {
      description: "Return JSON with line_items and a warm friendly tone",
      sample_files: [{ path: "fixtures/invoice.png", content: pngB64 }],
      idempotency_key: "idem-png-person",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as GenerateSuccess;
    assert.ok(body.n_person > 0);

    const db = new Database(sqlitePath);
    const person = db
      .prepare(
        `SELECT e.id FROM eval_set_members m JOIN evals e ON e.id = m.eval_id
         WHERE m.eval_set_id = ? AND e.score_how = 'person' LIMIT 1`,
      )
      .get(body.eval_set_id) as { id: string };
    const file = db
      .prepare(`SELECT path, content FROM eval_files WHERE eval_id = ?`)
      .get(person.id) as { path: string; content: Buffer } | undefined;
    db.close();
    assert.ok(file, "person eval should have an eval_files row");
    assert.equal(file.path, "fixtures/invoice.png");
    const bytes = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content ?? []);
    assert.ok(bytes.length > 0);

    const queued = await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: body.project_id,
        eval_set_id: body.eval_set_id,
        idempotency_key: "idem-png-queue",
      },
    });
    assert.equal(queued.statusCode, 200);

    const token = signMarkToken(apiKey, body.eval_set_id);
    const page = await app.inject({
      method: "GET",
      url: `/mark?eval_set_id=${encodeURIComponent(body.eval_set_id)}&token=${token}`,
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<img/);
  });

  it("extract with named fields yields field_equals code drafts", async () => {
    const res = await postGenerate(app, {
      description: "Extract named fields vendor and total from the document",
      idempotency_key: "idem-extract-named",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as GenerateSuccess;
    assert.ok(body.n_code > 0);
    const db = new Database(sqlitePath, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT e.program_check FROM eval_set_members m
           JOIN evals e ON e.id = m.eval_id WHERE m.eval_set_id = ?`,
        )
        .all(body.eval_set_id) as Array<{ program_check: string | null }>;
      const paths = rows
        .map((r) =>
          r.program_check
            ? (JSON.parse(r.program_check) as { kind?: string; expected?: { path?: string } })
            : null,
        )
        .filter((p) => p?.kind === "field_equals")
        .map((p) => p?.expected?.path);
      assert.ok(paths.includes("vendor"));
      assert.ok(paths.includes("total"));
    } finally {
      db.close();
    }
  });

  it("bare invoice still returns JOB_UNCLEAR without what_good_means", async () => {
    const res = await postGenerate(app, {
      description: "invoice",
      idempotency_key: "idem-bare-invoice",
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500);
    assert.equal(isAgentError(res.json()), true);
    assert.equal((res.json() as { code: string }).code, ErrorCode.JOB_UNCLEAR);
  });

  it("tone-only description yields person drafts and no fake JSON suite", async () => {
    const res = await postGenerate(app, {
      description: "Write a warm friendly good reply to the customer",
      idempotency_key: "idem-tone-only",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as GenerateSuccess;
    assert.ok(body.n_person > 0);
    assert.equal(body.n_code, 0);
    assert.equal(body.next_action.args.after_accept_tool, "queue_for_labeling");
    const db = new Database(sqlitePath, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT e.form_type, e.program_check FROM eval_set_members m
           JOIN evals e ON e.id = m.eval_id WHERE m.eval_set_id = ?`,
        )
        .all(body.eval_set_id) as Array<{
        form_type: string | null;
        program_check: string | null;
      }>;
      assert.ok(rows.some((r) => r.form_type === "rubric"));
      assert.ok(rows.every((r) => r.program_check == null));
    } finally {
      db.close();
    }
  });

  it("image sample PNG plus judgment yields person eval with file bytes", async () => {
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const res = await postGenerate(app, {
      description: "Judge whether this invoice photo is readable",
      sample_files: [{ path: "fixtures/invoice.png", content: pngB64 }],
      idempotency_key: "idem-image-judge",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as GenerateSuccess;
    assert.ok(body.n_person > 0);

    const db = new Database(sqlitePath);
    const person = db
      .prepare(
        `SELECT e.id FROM eval_set_members m JOIN evals e ON e.id = m.eval_id
         WHERE m.eval_set_id = ? AND e.score_how = 'person' LIMIT 1`,
      )
      .get(body.eval_set_id) as { id: string };
    const file = db
      .prepare(`SELECT path, content FROM eval_files WHERE eval_id = ?`)
      .get(person.id) as { path: string; content: Buffer } | undefined;
    db.close();
    assert.ok(file);
    assert.equal(file.path, "fixtures/invoice.png");
    const bytes = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content ?? []);
    assert.ok(bytes.length > 0);

    const queued = await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: body.project_id,
        eval_set_id: body.eval_set_id,
        idempotency_key: "idem-image-judge-queue",
      },
    });
    assert.equal(queued.statusCode, 200);
    const token = signMarkToken(apiKey, body.eval_set_id);
    const page = await app.inject({
      method: "GET",
      url: `/mark?eval_set_id=${encodeURIComponent(body.eval_set_id)}&token=${token}`,
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<img/);
    assert.doesNotMatch(page.body, /form_type": "file"/);
  });
});
