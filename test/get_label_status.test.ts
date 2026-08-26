import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createEvalSetVersion1, type DraftEval } from "../src/eval-set.js";
import { newJobId } from "../src/ids.js";
import { getLabelStatusOutputSchema } from "../src/tools/schema.js";
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

describe("get_label_status (J3)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-label-status-"));
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
    evalSetId = created.evalSetId;
    for (const ev of created.evals.filter((e) => e.score_how === "code")) {
      db.prepare(`UPDATE evals SET status = 'trusted' WHERE id = ?`).run(ev.eval_id);
    }
    db.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not return need_more_evals code", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        idempotency_key: "status-queue-1",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/get_label_status",
      headers: authHeaders(),
      payload: { project_id: projectId, eval_set_id: evalSetId },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(getLabelStatusOutputSchema.safeParse(body).success);
    assert.equal((body as { code?: string }).code, undefined);
    assert.equal((body as { enough_trusted: boolean }).enough_trusted, false);
    assert.ok((body as { mark_url: string | null }).mark_url);
    assert.equal(
      (body as { next_action: { tool: string } }).next_action.tool,
      "get_label_status",
    );
  });
});
