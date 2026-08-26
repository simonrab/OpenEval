import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createEvalSetVersion1, type DraftEval } from "../src/eval-set.js";
import { insertEvalFile } from "../src/eval-files.js";
import { newJobId } from "../src/ids.js";
import { signMarkToken } from "../src/mark/tokens.js";
import {
  acceptToken,
  authHeaders,
  createTestApp,
  fiveCodeDrafts,
  TEST_API_KEY,
} from "./helpers/run-fixtures.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_1x1 = Buffer.from(PNG_B64, "base64");

function personDraft(): DraftEval {
  return {
    title: "Tone check",
    score_how: "person",
    status: "draft",
    program_check: null,
    input_truncated: "Please help me with my order.",
  };
}

function seedPersonSet(
  db: Database.Database,
  projectId: string,
): { evalSetId: string; personEvalId: string } {
  const jobId = newJobId();
  db.prepare(
    `INSERT INTO jobs (id, project_id, description, limits, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
  ).run(jobId, projectId, "warm tone", new Date().toISOString());
  const created = createEvalSetVersion1(db, {
    projectId,
    jobId,
    drafts: [...fiveCodeDrafts().slice(0, 1), personDraft()],
  });
  const personEvalId = created.evals.find((e) => e.score_how === "person")!.eval_id;
  db.prepare(`UPDATE evals SET status = 'trusted' WHERE score_how = 'code'`).run();
  return { evalSetId: created.evalSetId, personEvalId };
}

describe("mark screen file display", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let personEvalId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-mark-file-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await createTestApp(sqlitePath);
    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeaders(),
      payload: {},
    });
    projectId = (proj.json() as { project_id: string }).project_id;
    const db = new Database(sqlitePath);
    const seeded = seedPersonSet(db, projectId);
    evalSetId = seeded.evalSetId;
    personEvalId = seeded.personEvalId;
    db.close();

    await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        idempotency_key: "mark-file-queue",
      },
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows an image on the mark screen and serves it with the mark token", async () => {
    const db = new Database(sqlitePath);
    insertEvalFile(db, {
      evalId: personEvalId,
      path: "fixtures/invoice.png",
      mime: "image/png",
      content: PNG_1x1,
    });
    db.close();

    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const page = await app.inject({
      method: "GET",
      url: `/mark?eval_set_id=${encodeURIComponent(evalSetId)}&token=${token}`,
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<img /);
    assert.match(page.body, /\/mark\/file\?/);
    assert.match(page.body, /pass_fail/);
    assert.doesNotMatch(page.body, /form_type": "file"/);

    const file = await app.inject({
      method: "GET",
      url: `/mark/file?eval_set_id=${encodeURIComponent(evalSetId)}&eval_id=${encodeURIComponent(personEvalId)}&token=${token}`,
    });
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers["content-type"], "image/png");
    assert.deepEqual(Buffer.from(file.rawPayload), PNG_1x1);
  });

  it("embeds a PDF on the mark screen", async () => {
    const db = new Database(sqlitePath);
    insertEvalFile(db, {
      evalId: personEvalId,
      path: "fixtures/invoice.pdf",
      mime: "application/pdf",
      content: Buffer.from("%PDF-1.4"),
    });
    db.close();

    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const page = await app.inject({
      method: "GET",
      url: `/mark?eval_set_id=${encodeURIComponent(evalSetId)}&token=${token}`,
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<embed /);
    assert.match(page.body, /application\/pdf/);
  });

  it("shows a missing-file note when the attachment has no bytes", async () => {
    const db = new Database(sqlitePath);
    insertEvalFile(db, {
      evalId: personEvalId,
      path: "fixtures/missing.png",
      mime: "image/png",
      content: Buffer.alloc(0),
    });
    db.close();

    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const page = await app.inject({
      method: "GET",
      url: `/mark?eval_set_id=${encodeURIComponent(evalSetId)}&token=${token}`,
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /missing\.png/);
    assert.match(page.body, /cannot mark|file missing/i);
  });

  it("rejects a file fetch with a bad token", async () => {
    const file = await app.inject({
      method: "GET",
      url: `/mark/file?eval_set_id=${encodeURIComponent(evalSetId)}&eval_id=${encodeURIComponent(personEvalId)}&token=deadbeef`,
    });
    assert.equal(file.statusCode, 401);
  });

  it("third-person screen shows the attached image", async () => {
    const db = new Database(sqlitePath);
    insertEvalFile(db, {
      evalId: personEvalId,
      path: "fixtures/invoice.png",
      mime: "image/png",
      content: PNG_1x1,
    });
    const people = db
      .prepare(
        `SELECT id, slot FROM people WHERE project_id = ? ORDER BY slot`,
      )
      .all(projectId) as Array<{ id: string; slot: string }>;
    db.close();
    const marker1 = people.find((p) => p.slot === "marker1")!.id;
    const marker2 = people.find((p) => p.slot === "marker2")!.id;
    const third = people.find((p) => p.slot === "third")!.id;

    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const base = {
      eval_set_id: evalSetId,
      eval_id: personEvalId,
      token,
      action: "submit",
      pass_fail: "pass",
    };
    await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json" },
      payload: { ...base, person_id: marker1, expected_text: "Alpha" },
    });
    await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json" },
      payload: { ...base, person_id: marker2, expected_text: "Beta" },
    });

    const html = await app.inject({
      method: "GET",
      url: `/mark/third?eval_set_id=${encodeURIComponent(evalSetId)}&eval_id=${encodeURIComponent(personEvalId)}&token=${token}&person_id=${third}`,
    });
    assert.equal(html.statusCode, 200);
    assert.match(html.body, /<img/);
    assert.match(html.body, /\/mark\/file\?/);
  });
});

describe("register_failure file content on mark screen", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-reg-file-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await createTestApp(sqlitePath);
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("register_failure with file content shows the image on the mark screen", async () => {
    const gen = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "Return JSON with line_items and a warm friendly tone",
        idempotency_key: "reg-file-gen",
      },
    });
    assert.equal(gen.statusCode, 200);
    const suite = gen.json() as {
      project_id: string;
      eval_set_id: string;
    };

    const db = new Database(sqlitePath);
    const allEvals = db
      .prepare(
        `SELECT e.id AS eval_id, e.score_how FROM eval_set_members m
         JOIN evals e ON e.id = m.eval_id WHERE m.eval_set_id = ?`,
      )
      .all(suite.eval_set_id) as Array<{ eval_id: string; score_how: string }>;
    db.close();
    const codeIds = allEvals
      .filter((e) => e.score_how === "code")
      .map((e) => e.eval_id);
    const personIds = allEvals
      .filter((e) => e.score_how === "person")
      .map((e) => e.eval_id);
    assert.ok(personIds.length >= 1);

    const accepted = await app.inject({
      method: "POST",
      url: "/accept",
      headers: { "content-type": "application/json" },
      payload: {
        eval_set_id: suite.eval_set_id,
        token: acceptToken(suite.eval_set_id),
        accept: codeIds,
        reject: [],
      },
    });
    assert.ok(accepted.statusCode === 200 || accepted.statusCode === 303);

    const queued = await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: suite.project_id,
        eval_set_id: suite.eval_set_id,
        idempotency_key: "reg-file-queue",
      },
    });
    assert.equal(queued.statusCode, 200);

    const peopleDb = new Database(sqlitePath, { readonly: true });
    const people = peopleDb
      .prepare(
        `SELECT id, slot FROM people WHERE project_id = ? ORDER BY slot`,
      )
      .all(suite.project_id) as Array<{ id: string; slot: string }>;
    peopleDb.close();
    const marker1 = people.find((p) => p.slot === "marker1")!.id;
    const marker2 = people.find((p) => p.slot === "marker2")!.id;
    const markToken = signMarkToken(TEST_API_KEY, suite.eval_set_id);
    const originalPerson = personIds[0]!;
    const agree = {
      eval_set_id: suite.eval_set_id,
      eval_id: originalPerson,
      token: markToken,
      action: "submit",
      rubric_tone: "pass",
      rubric_length: "pass",
    };
    await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json" },
      payload: { ...agree, person_id: marker1 },
    });
    await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json" },
      payload: { ...agree, person_id: marker2 },
    });

    const fail = await app.inject({
      method: "POST",
      url: "/v1/tools/register_failure",
      headers: authHeaders(),
      payload: {
        project_id: suite.project_id,
        eval_set_id: suite.eval_set_id,
        input: {
          prompt: "screenshot of a cold reply",
          files: [{ path: "shot.png", content: PNG_B64 }],
        },
        why_bad: "tone was cold",
        idempotency_key: "reg-file-fail",
      },
    });
    assert.equal(fail.statusCode, 200);
    const failed = fail.json() as {
      eval_id: string;
      eval_set_id: string;
    };

    const queuedNew = await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: suite.project_id,
        eval_set_id: failed.eval_set_id,
        idempotency_key: "reg-file-queue-new",
      },
    });
    assert.equal(queuedNew.statusCode, 200);

    const newToken = signMarkToken(TEST_API_KEY, failed.eval_set_id);
    const page = await app.inject({
      method: "GET",
      url: `/mark?eval_set_id=${encodeURIComponent(failed.eval_set_id)}&token=${newToken}`,
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<img/);
    assert.match(page.body, /\/mark\/file\?/);
  });
});
