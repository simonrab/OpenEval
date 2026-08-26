import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { copyEvalSetForward } from "../src/eval-set-copy.js";
import { createEvalSetVersion1 } from "../src/eval-set.js";
import { openDb } from "../src/db.js";
import { newJobId, newPersonId } from "../src/ids.js";
import { fiveCodeDrafts } from "./helpers/run-fixtures.js";

describe("eval-set-copy", () => {
  let dir: string;
  let db: Database.Database;
  let projectId: string;
  let sourceEvalSetId: string;
  let evalIds: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-copy-"));
    db = openDb(join(dir, "evalrouter.sqlite"));
    projectId = "prj_copy_test";
    db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
      projectId,
      new Date().toISOString(),
    );
    const jobId = newJobId();
    db.prepare(
      `INSERT INTO jobs (id, project_id, description, limits, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(jobId, projectId, "JSON job", new Date().toISOString());
    const created = createEvalSetVersion1(db, {
      projectId,
      jobId,
      drafts: fiveCodeDrafts(),
    });
    sourceEvalSetId = created.evalSetId;
    evalIds = created.evals.map((e) => e.eval_id);
    for (const id of evalIds) {
      db.prepare(`UPDATE evals SET status = 'trusted' WHERE id = ?`).run(id);
    }
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a new ste_ with version+1 and previous_eval_set_id", () => {
    const result = copyEvalSetForward(db, {
      projectId,
      sourceEvalSetId,
    });
    assert.match(result.newEvalSetId, /^ste_/);
    assert.equal(result.previousEvalSetId, sourceEvalSetId);
    assert.equal(result.version, 2);
    assert.deepEqual([...result.oldEvalIds].sort(), [...evalIds].sort());

    const oldRow = db
      .prepare("SELECT version FROM eval_sets WHERE id = ?")
      .get(sourceEvalSetId) as { version: number };
    assert.equal(oldRow.version, 1);

    const newRow = db
      .prepare(
        "SELECT version, previous_eval_set_id FROM eval_sets WHERE id = ?",
      )
      .get(result.newEvalSetId) as {
      version: number;
      previous_eval_set_id: string;
    };
    assert.equal(newRow.version, 2);
    assert.equal(newRow.previous_eval_set_id, sourceEvalSetId);
  });

  it("copies membership; old ste_ member count unchanged", () => {
    const result = copyEvalSetForward(db, {
      projectId,
      sourceEvalSetId,
    });
    const oldCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM eval_set_members WHERE eval_set_id = ?",
        )
        .get(sourceEvalSetId) as { n: number }
    ).n;
    const newCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM eval_set_members WHERE eval_set_id = ?",
        )
        .get(result.newEvalSetId) as { n: number }
    ).n;
    assert.equal(oldCount, evalIds.length);
    assert.equal(newCount, evalIds.length);

    const newMembers = db
      .prepare(
        "SELECT eval_id FROM eval_set_members WHERE eval_set_id = ? ORDER BY eval_id",
      )
      .all(result.newEvalSetId) as Array<{ eval_id: string }>;
    assert.deepEqual(
      newMembers.map((m) => m.eval_id).sort(),
      [...evalIds].sort(),
    );
  });

  it("copies frozen marks to the new eval-set version", () => {
    const personEvalId = evalIds[0]!;
    db.prepare(`UPDATE evals SET score_how = 'person', status = 'trusted' WHERE id = ?`).run(
      personEvalId,
    );
    const personId = newPersonId();
    db.prepare(
      `INSERT INTO people (id, project_id, display_name, slot, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(personId, projectId, "Marker 1", "marker1", new Date().toISOString());
    const markJson = JSON.stringify({ form: "pass_fail", pass: true });
    db.prepare(
      `INSERT INTO marks (eval_set_id, eval_id, person_id, mark_json, is_third, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(sourceEvalSetId, personEvalId, personId, markJson, new Date().toISOString());

    const result = copyEvalSetForward(db, {
      projectId,
      sourceEvalSetId,
    });

    const copied = db
      .prepare(
        `SELECT mark_json FROM marks
         WHERE eval_set_id = ? AND eval_id = ? AND person_id = ?`,
      )
      .get(result.newEvalSetId, personEvalId, personId) as
      | { mark_json: string }
      | undefined;
    assert.ok(copied);
    assert.equal(copied.mark_json, markJson);

    const oldMark = db
      .prepare(
        `SELECT mark_json FROM marks
         WHERE eval_set_id = ? AND eval_id = ? AND person_id = ?`,
      )
      .get(sourceEvalSetId, personEvalId, personId) as { mark_json: string };
    assert.equal(oldMark.mark_json, markJson);
  });
});
