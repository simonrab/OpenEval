import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createEvalSetVersion1, type DraftEval } from "../src/eval-set.js";
import { newJobId } from "../src/ids.js";
import { queueForLabelingOutputSchema } from "../src/tools/schema.js";
import {
  authHeaders,
  createTestApp,
  fiveCodeDrafts,
} from "./helpers/run-fixtures.js";

function mixedDrafts(): DraftEval[] {
  return [
    ...fiveCodeDrafts().slice(0, 2),
    {
      title: "Tone check",
      score_how: "person",
      status: "draft",
      program_check: null,
      input_truncated: "Please help me with my order.",
    },
  ];
}

function seedMixedSet(db: Database.Database, projectId: string): string {
  const jobId = newJobId();
  db.prepare(
    `INSERT INTO jobs (id, project_id, description, limits, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
  ).run(
    jobId,
    projectId,
    JSON.stringify({
      how_it_should_behave: "warm tone",
      success: "helpful reply",
      must_never: "rude words",
    }),
    new Date().toISOString(),
  );
  const created = createEvalSetVersion1(db, {
    projectId,
    jobId,
    drafts: mixedDrafts(),
  });
  for (const ev of created.evals.filter((e) => e.score_how === "code")) {
    db.prepare(`UPDATE evals SET status = 'trusted' WHERE id = ?`).run(ev.eval_id);
  }
  return created.evalSetId;
}

describe("queue_for_labeling (J3)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-queue-"));
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
    evalSetId = seedMixedSet(db, projectId);
    db.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("queues person evals only and ignores code eval ids", async () => {
    const db = new Database(sqlitePath, { readonly: true });
    const codeId = (
      db
        .prepare(
          `SELECT e.id FROM eval_set_members m JOIN evals e ON e.id = m.eval_id
           WHERE m.eval_set_id = ? AND e.score_how = 'code' LIMIT 1`,
        )
        .get(evalSetId) as { id: string }
    ).id;
    const personId = (
      db
        .prepare(
          `SELECT e.id FROM eval_set_members m JOIN evals e ON e.id = m.eval_id
           WHERE m.eval_set_id = ? AND e.score_how = 'person' LIMIT 1`,
        )
        .get(evalSetId) as { id: string }
    ).id;
    db.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        eval_ids: [codeId, personId],
        idempotency_key: "queue-mixed-1",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(queueForLabelingOutputSchema.safeParse(body).success);
    assert.equal((body as { n_queued: number }).n_queued, 1);
    assert.ok((body as { mark_url: string }).mark_url?.includes("/mark"));
    assert.equal(
      (body as { next_action: { tool: string } }).next_action.tool,
      "get_label_status",
    );
  });

  it("returns n_queued 0 and run_evals when no person evals", async () => {
    const db = new Database(sqlitePath);
    const codeOnlyProject = "prj_code_only";
    db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
      codeOnlyProject,
      new Date().toISOString(),
    );
    const jobId = newJobId();
    db.prepare(
      `INSERT INTO jobs (id, project_id, description, limits, created_at)
       VALUES (?, ?, 'json', NULL, ?)`,
    ).run(jobId, codeOnlyProject, new Date().toISOString());
    const created = createEvalSetVersion1(db, {
      projectId: codeOnlyProject,
      jobId,
      drafts: fiveCodeDrafts(),
    });
    db.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: codeOnlyProject,
        eval_set_id: created.evalSetId,
        idempotency_key: "queue-code-only",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      n_queued: number;
      mark_url: string | null;
      next_action: { tool: string | null };
    };
    assert.equal(body.n_queued, 0);
    assert.equal(body.mark_url, null);
    assert.equal(body.next_action.tool, "run_evals");
  });
});
