import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createEvalSetVersion1, type DraftEval } from "../src/eval-set.js";
import { newJobId } from "../src/ids.js";
import { signMarkToken } from "../src/mark/tokens.js";
import { getLabelStatusOutputSchema } from "../src/tools/schema.js";
import { ErrorCode } from "../src/tools/types.js";
import {
  authHeaders,
  createTestApp,
  fiveCodeDrafts,
  storeCustomerKey,
  TEST_API_KEY,
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

describe("mark screen flow (J3)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let personEvalId: string;
  let marker1: string;
  let marker2: string;
  let third: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-mark-screen-"));
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
    personEvalId = (
      db
        .prepare(
          `SELECT e.id FROM eval_set_members m JOIN evals e ON e.id = m.eval_id
           WHERE m.eval_set_id = ? AND e.score_how = 'person' LIMIT 1`,
        )
        .get(evalSetId) as { id: string }
    ).id;
    db.close();

    await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        idempotency_key: "mark-flow-queue",
      },
    });

    const db2 = new Database(sqlitePath, { readonly: true });
    const people = db2
      .prepare(
        `SELECT id, slot FROM people WHERE project_id = ? ORDER BY slot`,
      )
      .all(projectId) as Array<{ id: string; slot: string }>;
    marker1 = people.find((p) => p.slot === "marker1")!.id;
    marker2 = people.find((p) => p.slot === "marker2")!.id;
    third = people.find((p) => p.slot === "third")!.id;
    db2.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET mark HTML shows input and does not show model names", async () => {
    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const res = await app.inject({
      method: "GET",
      url: `/mark?eval_set_id=${encodeURIComponent(evalSetId)}&token=${token}`,
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(res.body, /warm tone/i);
    assert.match(res.body, /left in queue/i);
    assert.doesNotMatch(res.body, /gpt-4/i);
    assert.doesNotMatch(res.body, /openrouter/i);
  });

  it("two agreeing marks trust the eval and get_label_status can reach enough_trusted with more trusted code evals", async () => {
    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const mark = {
      eval_set_id: evalSetId,
      eval_id: personEvalId,
      token,
      action: "submit",
      pass_fail: "pass",
      expected_text: "Happy to help!",
    };
    const a = await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: { ...mark, person_id: marker1 },
    });
    assert.equal(a.statusCode, 200);
    const b = await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: { ...mark, person_id: marker2 },
    });
    assert.equal(b.statusCode, 200);
    assert.equal((b.json() as { trusted: boolean }).trusted, true);

    const db = new Database(sqlitePath);
    const extraDrafts = fiveCodeDrafts();
    const jobId = newJobId();
    for (let i = 0; i < extraDrafts.length; i++) {
      const draft = extraDrafts[i]!;
      const evalId = newJobId().replace("job_", "cas_");
      db.prepare(
        `INSERT INTO evals
          (id, title, score_how, status, program_check, input_truncated, created_at)
         VALUES (?, ?, 'code', 'trusted', ?, ?, ?)`,
      ).run(
        evalId,
        `${draft.title}-${i}`,
        JSON.stringify(draft.program_check),
        draft.input_truncated,
        new Date().toISOString(),
      );
      db.prepare(
        `INSERT INTO eval_set_members (eval_set_id, eval_id) VALUES (?, ?)`,
      ).run(evalSetId, evalId);
    }
    for (let i = 0; i < 3; i++) {
      const evalId = newJobId().replace("job_", "cas_");
      db.prepare(
        `INSERT INTO evals
          (id, title, score_how, status, program_check, input_truncated, created_at)
         VALUES (?, ?, 'code', 'trusted', ?, ?, ?)`,
      ).run(
        evalId,
        `Extra code eval ${i}`,
        JSON.stringify({ kind: "json_valid", expected: true }),
        "Return JSON",
        new Date().toISOString(),
      );
      db.prepare(
        `INSERT INTO eval_set_members (eval_set_id, eval_id) VALUES (?, ?)`,
      ).run(evalSetId, evalId);
    }
    db.close();

    const status = await app.inject({
      method: "POST",
      url: "/v1/tools/get_label_status",
      headers: authHeaders(),
      payload: { project_id: projectId, eval_set_id: evalSetId },
    });
    assert.equal(status.statusCode, 200);
    const body = status.json();
    assert.ok(getLabelStatusOutputSchema.safeParse(body).success);
    assert.equal((body as { enough_trusted: boolean }).enough_trusted, true);
    assert.equal(
      (body as { next_action: { tool: string } }).next_action.tool,
      "run_evals",
    );
  });

  it("disagreement lets third person decide; they cannot mark twice", async () => {
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
      payload: { ...base, person_id: marker1, expected_text: "A" },
    });
    await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json" },
      payload: { ...base, person_id: marker2, expected_text: "B" },
    });

    const thirdRes = await app.inject({
      method: "POST",
      url: "/mark/third",
      headers: { "content-type": "application/json" },
      payload: {
        eval_set_id: evalSetId,
        eval_id: personEvalId,
        token,
        person_id: third,
        action: "submit",
        pick_person_id: marker1,
      },
    });
    assert.equal(thirdRes.statusCode, 200);
    assert.equal((thirdRes.json() as { trusted: boolean }).trusted, true);

    const retry = await app.inject({
      method: "POST",
      url: "/mark/third",
      headers: { "content-type": "application/json" },
      payload: {
        eval_set_id: evalSetId,
        eval_id: personEvalId,
        token,
        person_id: third,
        action: "submit",
        pick_person_id: marker2,
      },
    });
    assert.equal(retry.statusCode, 400);
  });

  it("third screen HTML shows both prior marks", async () => {
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
    assert.match(html.body, /Alpha/);
    assert.match(html.body, /Beta/);
  });

  it("cannot mark keeps eval untrusted", async () => {
    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const res = await app.inject({
      method: "POST",
      url: "/mark/cannot",
      headers: { "content-type": "application/json" },
      payload: {
        eval_set_id: evalSetId,
        eval_id: personEvalId,
        token,
        person_id: marker1,
        reason: "broken input",
      },
    });
    assert.equal(res.statusCode, 200);
    const db = new Database(sqlitePath, { readonly: true });
    const row = db
      .prepare(`SELECT status FROM evals WHERE id = ?`)
      .get(personEvalId) as { status: string };
    db.close();
    assert.notEqual(row.status, "trusted");
  });

  it("run_evals returns need_more_evals with mark_url when queue unfinished", async () => {
    const db = new Database(sqlitePath);
    const keysRef = await storeCustomerKey(db, projectId);
    db.close();
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: "run-need-mark-url",
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string; mark_url?: string | null };
    assert.equal(body.code, ErrorCode.need_more_evals);
    assert.ok(body.mark_url?.includes("/mark"));
  });
});
