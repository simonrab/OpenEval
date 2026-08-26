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
  authHeaders,
  createTestApp,
  fiveCodeDrafts,
  TEST_API_KEY,
} from "./helpers/run-fixtures.js";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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
});
