import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createEvalSetVersion1, type DraftEval } from "../src/eval-set.js";
import { newJobId } from "../src/ids.js";
import { parseFormRenderMeta } from "../src/mark/forms.js";
import { signMarkToken } from "../src/mark/tokens.js";
import {
  authHeaders,
  createTestApp,
  TEST_API_KEY,
} from "./helpers/run-fixtures.js";

describe("parseFormRenderMeta", () => {
  it("derives field names and defaults from draft_mark JSON", () => {
    const meta = parseFormRenderMeta(
      JSON.stringify({
        fields: { total_cents: "100", sku: "abc" },
      }),
      null,
      "fields",
    );
    assert.deepEqual(meta.fieldNames, ["total_cents", "sku"]);
    assert.equal(meta.fieldDefaults.total_cents, "100");
  });

  it("derives rubric checks from draft_mark JSON", () => {
    const meta = parseFormRenderMeta(
      JSON.stringify({
        rubric: { tone: "pass", length: "fail" },
      }),
      null,
      "rubric",
    );
    assert.deepEqual(meta.rubricNames, ["tone", "length"]);
    assert.equal(meta.rubricDefaults.tone, "pass");
  });

  it("merges form_spec field names with draft defaults", () => {
    const meta = parseFormRenderMeta(
      JSON.stringify({ fields: { name: "Alice" } }),
      JSON.stringify({ fields: ["name", "email"] }),
      "fields",
    );
    assert.deepEqual(meta.fieldNames, ["name", "email"]);
    assert.equal(meta.fieldDefaults.name, "Alice");
  });

  it("uses sensible defaults when metadata is absent", () => {
    assert.deepEqual(
      parseFormRenderMeta(null, null, "fields").fieldNames,
      ["expected"],
    );
    assert.deepEqual(
      parseFormRenderMeta(null, null, "rubric").rubricNames,
      ["quality"],
    );
  });
});

describe("mark form HTML (fields/rubric/tool)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let fieldsEvalId: string;
  let rubricEvalId: string;
  let toolEvalId: string;
  let marker1: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-mark-forms-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await createTestApp(sqlitePath);
    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeaders(),
      payload: {},
    });
    projectId = (proj.json() as { project_id: string }).project_id;

    const drafts: DraftEval[] = [
      {
        title: "Extract fields",
        score_how: "person",
        status: "draft",
        program_check: null,
        input_truncated: "Invoice #42",
      },
      {
        title: "Tone rubric",
        score_how: "person",
        status: "draft",
        program_check: null,
        input_truncated: "Hello there",
      },
      {
        title: "Tool call",
        score_how: "person",
        status: "draft",
        program_check: null,
        input_truncated: "Search for cats",
      },
    ];

    const db = new Database(sqlitePath);
    const jobId = newJobId();
    db.prepare(
      `INSERT INTO jobs (id, project_id, description, limits, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(jobId, projectId, "form types job", new Date().toISOString());
    const created = createEvalSetVersion1(db, {
      projectId,
      jobId,
      drafts,
    });
    evalSetId = created.evalSetId;
    fieldsEvalId = created.evals[0]!.eval_id;
    rubricEvalId = created.evals[1]!.eval_id;
    toolEvalId = created.evals[2]!.eval_id;

    db.prepare(
      `UPDATE evals SET form_type = ?, form_spec = ?, draft_mark = ? WHERE id = ?`,
    ).run(
      "fields",
      JSON.stringify({ fields: ["total_cents", "vendor"] }),
      JSON.stringify({ fields: { total_cents: "100", vendor: "Acme" } }),
      fieldsEvalId,
    );
    db.prepare(
      `UPDATE evals SET form_type = ?, draft_mark = ? WHERE id = ?`,
    ).run(
      "rubric",
      JSON.stringify({ rubric: { tone: "pass", clarity: "pass" } }),
      rubricEvalId,
    );
    db.prepare(
      `UPDATE evals SET form_type = ?, draft_mark = ? WHERE id = ?`,
    ).run(
      "tool",
      JSON.stringify({ tool: { name: "search", args: { q: "cats" } } }),
      toolEvalId,
    );
    db.close();

    await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        idempotency_key: "mark-forms-queue",
      },
    });

    const dbQueue = new Database(sqlitePath);
    dbQueue
      .prepare(
        `UPDATE mark_queue SET queued_at = ? WHERE eval_set_id = ? AND eval_id = ?`,
      )
      .run("2020-01-01T00:00:00.000Z", evalSetId, fieldsEvalId);
    dbQueue
      .prepare(
        `UPDATE mark_queue SET queued_at = ? WHERE eval_set_id = ? AND eval_id = ?`,
      )
      .run("2020-01-02T00:00:00.000Z", evalSetId, rubricEvalId);
    dbQueue
      .prepare(
        `UPDATE mark_queue SET queued_at = ? WHERE eval_set_id = ? AND eval_id = ?`,
      )
      .run("2020-01-03T00:00:00.000Z", evalSetId, toolEvalId);
    dbQueue.close();

    const db2 = new Database(sqlitePath, { readonly: true });
    marker1 = (
      db2
        .prepare(`SELECT id FROM people WHERE project_id = ? AND slot = 'marker1'`)
        .get(projectId) as { id: string }
    ).id;
    db2.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders fields form inputs on mark screen", async () => {
    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const res = await app.inject({
      method: "GET",
      url: `/mark?eval_set_id=${encodeURIComponent(evalSetId)}&token=${token}`,
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /name="field_total_cents"/);
    assert.match(res.body, /name="field_vendor"/);
    assert.match(res.body, /100/);
    assert.doesNotMatch(res.body, /not wired on this screen/i);
  });

  it("submits fields mark and two agreeing marks trust the eval", async () => {
    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const db = new Database(sqlitePath);
    const marker2 = (
      db
        .prepare(`SELECT id FROM people WHERE project_id = ? AND slot = 'marker2'`)
        .get(projectId) as { id: string }
    ).id;
    db.close();

    const payload = {
      eval_set_id: evalSetId,
      eval_id: fieldsEvalId,
      token,
      action: "submit",
      field_total_cents: "100",
      field_vendor: "Acme",
    };
    const a = await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: { ...payload, person_id: marker1 },
    });
    assert.equal(a.statusCode, 200);
    const b = await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: { ...payload, person_id: marker2 },
    });
    assert.equal(b.statusCode, 200);
    assert.equal((b.json() as { trusted: boolean }).trusted, true);
  });

  it("renders rubric form when that eval is next after fields trusted", async () => {
    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const db = new Database(sqlitePath);
    db.prepare(`UPDATE evals SET status = 'trusted' WHERE id = ?`).run(fieldsEvalId);
    db.prepare(`UPDATE mark_queue SET state = 'trusted' WHERE eval_id = ?`).run(
      fieldsEvalId,
    );
    db.close();

    const res = await app.inject({
      method: "GET",
      url: `/mark?eval_set_id=${encodeURIComponent(evalSetId)}&token=${token}`,
    });
    assert.match(res.body, /name="rubric_tone"/);
    assert.match(res.body, /name="rubric_clarity"/);
  });

  it("submits tool mark via form fields", async () => {
    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const db = new Database(sqlitePath);
    db.prepare(`UPDATE evals SET status = 'trusted' WHERE id IN (?, ?)`).run(
      fieldsEvalId,
      rubricEvalId,
    );
    db.prepare(
      `UPDATE mark_queue SET state = 'trusted' WHERE eval_id IN (?, ?)`,
    ).run(fieldsEvalId, rubricEvalId);
    db.prepare(`UPDATE evals SET form_type = 'tool' WHERE id = ?`).run(toolEvalId);
    db.close();

    const res = await app.inject({
      method: "GET",
      url: `/mark?eval_set_id=${encodeURIComponent(evalSetId)}&token=${token}`,
    });
    assert.match(res.body, /name="tool_name"/);
    assert.match(res.body, /name="tool_args"/);
    assert.match(res.body, /search/);

    const marker2 = (
      new Database(sqlitePath, { readonly: true })
        .prepare(`SELECT id FROM people WHERE project_id = ? AND slot = 'marker2'`)
        .get(projectId) as { id: string }
    ).id;

    const payload = {
      eval_set_id: evalSetId,
      eval_id: toolEvalId,
      token,
      action: "submit",
      tool_name: "search",
      tool_args: '{"q":"cats"}',
    };
    await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json" },
      payload: { ...payload, person_id: marker1 },
    });
    const b = await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: { ...payload, person_id: marker2 },
    });
    assert.equal(b.statusCode, 200);
    assert.equal((b.json() as { trusted: boolean }).trusted, true);
  });
});
