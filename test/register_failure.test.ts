import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { listMembers } from "../src/eval-set.js";
import { registerFailureOutputSchema } from "../src/tools/schema.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";
import {
  authHeaders,
  createTestApp,
  seedFiveTrustedEvals,
  storeCustomerKey,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

type RegisterSuccess = {
  eval_id: string;
  eval_set_id: string;
  previous_eval_set_id: string;
  version: number;
  score_how: "code" | "person";
  trusted: boolean;
  status: string;
  old_eval_ids: string[];
  mark_url: string | null;
  next_action: {
    tool: string | null;
    args: Record<string, unknown>;
    ask_human: string | null;
  };
};

async function postRegister(
  app: FastifyInstance,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/v1/tools/register_failure",
    headers: authHeaders(),
    payload,
  });
}

describe("register_failure (J5)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let oldEvalIds: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-register-"));
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
    try {
      const seeded = seedFiveTrustedEvals(db, projectId);
      evalSetId = seeded.evalSetId;
      oldEvalIds = seeded.evalIds;
    } finally {
      db.close();
    }
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("program_check → trusted code eval, run_evals on new ste_, no mark", async () => {
    const res = await postRegister(app, {
      project_id: projectId,
      eval_set_id: evalSetId,
      input: { prompt: "Return JSON without total_cents" },
      output: { line_items: [{ sku: "a", qty: 1 }] },
      why_bad: "total_cents missing from JSON",
      program_check: {
        kind: "field_equals",
        expected: { path: "total_cents", exists: true },
      },
      idempotency_key: "reg-code-1",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as RegisterSuccess;
    const parsed = registerFailureOutputSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed));

    assert.match(body.eval_id, /^cas_/);
    assert.match(body.eval_set_id, /^ste_/);
    assert.notEqual(body.eval_set_id, evalSetId);
    assert.equal(body.previous_eval_set_id, evalSetId);
    assert.equal(body.version, 2);
    assert.equal(body.score_how, "code");
    assert.equal(body.trusted, true);
    assert.equal(body.status, "trusted");
    assert.equal(body.mark_url, null);
    assert.equal(body.next_action.tool, "run_evals");
    assert.equal(body.next_action.args.project_id, projectId);
    assert.equal(body.next_action.args.eval_set_id, body.eval_set_id);
    assert.equal(body.next_action.ask_human, null);
    assert.deepEqual([...body.old_eval_ids].sort(), [...oldEvalIds].sort());
  });

  it("version 2 = new eval + all v1; v1 unchanged", async () => {
    const res = await postRegister(app, {
      project_id: projectId,
      eval_set_id: evalSetId,
      input: { prompt: "missing total_cents" },
      why_bad: "total_cents missing from JSON",
      program_check: {
        kind: "field_equals",
        expected: { path: "total_cents", exists: true },
      },
      idempotency_key: "reg-version-1",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as RegisterSuccess;

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const v1Count = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM eval_set_members WHERE eval_set_id = ?",
          )
          .get(evalSetId) as { n: number }
      ).n;
      assert.equal(v1Count, oldEvalIds.length);

      const v1Set = db
        .prepare("SELECT version FROM eval_sets WHERE id = ?")
        .get(evalSetId) as { version: number };
      assert.equal(v1Set.version, 1);

      const v2Members = db
        .prepare(
          "SELECT eval_id FROM eval_set_members WHERE eval_set_id = ?",
        )
        .all(body.eval_set_id) as Array<{ eval_id: string }>;
      assert.equal(v2Members.length, oldEvalIds.length + 1);
      const v2Ids = v2Members.map((m) => m.eval_id);
      for (const id of oldEvalIds) {
        assert.ok(v2Ids.includes(id), `old eval ${id} missing from v2`);
      }
      assert.ok(v2Ids.includes(body.eval_id));
    } finally {
      db.close();
    }
  });

  it("person-needed failure → draft, mark next, not trusted", async () => {
    const res = await postRegister(app, {
      project_id: projectId,
      eval_set_id: evalSetId,
      input: { prompt: "The reply felt cold and unhelpful." },
      why_bad: "tone too cold for support",
      idempotency_key: "reg-person-1",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as RegisterSuccess;
    assert.equal(body.score_how, "person");
    assert.equal(body.trusted, false);
    assert.equal(body.status, "draft");
    assert.equal(body.next_action.tool, "queue_for_labeling");
    assert.equal(body.next_action.args.project_id, projectId);
    assert.equal(body.next_action.args.eval_set_id, body.eval_set_id);
    assert.equal(typeof body.mark_url, "string");
    assert.ok(body.mark_url!.length > 0);
  });

  it("same idempotency_key returns existing new ste_ and cas_", async () => {
    const payload = {
      project_id: projectId,
      eval_set_id: evalSetId,
      input: { prompt: "bad json" },
      why_bad: "total_cents missing",
      program_check: {
        kind: "field_equals" as const,
        expected: { path: "total_cents", exists: true },
      },
      idempotency_key: "reg-idem-1",
    };
    const first = await postRegister(app, payload);
    const second = await postRegister(app, payload);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const a = first.json() as RegisterSuccess;
    const b = second.json() as RegisterSuccess;
    assert.equal(a.eval_id, b.eval_id);
    assert.equal(a.eval_set_id, b.eval_set_id);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const setCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM eval_sets WHERE project_id = ?",
          )
          .get(projectId) as { n: number }
      ).n;
      assert.equal(setCount, 2);
      const newEvalCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM evals
             WHERE id NOT IN (${oldEvalIds.map(() => "?").join(",")})`,
          )
          .get(...oldEvalIds) as { n: number }
      ).n;
      assert.equal(newEvalCount, 1);
    } finally {
      db.close();
    }
  });

  it("returns SUITE_NOT_FOUND for unknown eval_set_id", async () => {
    const res = await postRegister(app, {
      project_id: projectId,
      eval_set_id: "ste_missing",
      input: { prompt: "x" },
      why_bad: "bad",
      idempotency_key: "reg-missing-ste",
    });
    assert.equal(res.statusCode, 404);
    assert.equal(isAgentError(res.json()), true);
    assert.equal((res.json() as { code: string }).code, ErrorCode.SUITE_NOT_FOUND);
  });

  it("run_evals on new version includes the new eval and old ones", async () => {
    const reg = await postRegister(app, {
      project_id: projectId,
      eval_set_id: evalSetId,
      input: { prompt: "no total" },
      why_bad: "total_cents missing",
      program_check: {
        kind: "field_equals",
        expected: { path: "total_cents", exists: true },
      },
      idempotency_key: "reg-run-1",
    });
    const registered = reg.json() as RegisterSuccess;
    const db = new Database(sqlitePath);
    let keysRef: string;
    try {
      keysRef = await storeCustomerKey(db, projectId);
    } finally {
      db.close();
    }

    const run = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: registered.eval_set_id,
        keys_ref: keysRef,
        max_eval_spend_usd: 5,
        idempotency_key: "run-after-reg-1",
      },
    });
    assert.equal(run.statusCode, 200);

    const readDb = new Database(sqlitePath, { readonly: true });
    try {
      const members = listMembers(readDb, registered.eval_set_id);
      const trusted = members.filter((m) => m.status === "trusted");
      assert.equal(trusted.length, oldEvalIds.length + 1);
      assert.ok(trusted.some((m) => m.eval_id === registered.eval_id));
    } finally {
      readDb.close();
    }
  });

  it("recheck after J5: old ste_ unchanged, new ste_ includes the failure", async () => {
    const db = new Database(sqlitePath);
    const keysRef = await storeCustomerKey(db, projectId);
    const now = new Date().toISOString();
    const recId = "rec_j5_recheck";
    const namedModelId = "openai/gpt-4o-mini";
    db.prepare(
      `INSERT INTO runs
        (id, project_id, eval_set_id, eval_set_version, status, code, models,
         max_eval_spend_usd, keys_ref, intent, named_model, new_failures,
         spend_usd, idempotency_key, created_at, updated_at)
       VALUES ('run_j5_v1', ?, ?, 1, 'succeeded', NULL, ?, 5, ?, 'new_feature',
               NULL, NULL, 0.2, 'seed-j5-v1', ?, ?)`,
    ).run(projectId, evalSetId, JSON.stringify([namedModelId]), keysRef, now, now);
    db.prepare(
      `INSERT INTO recommendations
        (id, project_id, eval_set_id, run_id, intent, named_model_id,
         backup_model_ids, quality_json, time_json, cost_usd, failing_eval_ids, created_at)
       VALUES (?, ?, ?, 'run_j5_v1', 'new_feature', ?, '[]',
               '{"n_pass":5,"n_fail":0}', '{"p50":100,"p95":200}', 0.2, '[]', ?)`,
    ).run(recId, projectId, evalSetId, namedModelId, now);
    db.close();

    const beforeDb = new Database(sqlitePath, { readonly: true });
    const beforeIds = listMembers(beforeDb, evalSetId).map((m) => m.eval_id).sort();
    beforeDb.close();

    const registered = (
      await postRegister(app, {
        project_id: projectId,
        eval_set_id: evalSetId,
        input: { prompt: "no total after live fail" },
        why_bad: "total_cents missing",
        program_check: {
          kind: "field_equals",
          expected: { path: "total_cents", exists: true },
        },
        idempotency_key: "reg-j5-recheck",
      })
    ).json() as RegisterSuccess;

    const oldRun = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        max_eval_spend_usd: 5,
        keys_ref: keysRef,
        intent: "recheck",
        named_model: { rec_id: recId, model_id: namedModelId },
        idempotency_key: "recheck-j5-old",
      },
    });
    assert.equal(oldRun.statusCode, 200);
    const oldReport = await waitForRunComplete(
      app,
      projectId,
      (oldRun.json() as { run_id: string }).run_id,
    );
    const oldScored = oldReport.eval_ids_scored as string[];
    assert.ok(!oldScored.includes(registered.eval_id));
    const afterDb = new Database(sqlitePath, { readonly: true });
    const membersAfter = listMembers(afterDb, evalSetId);
    afterDb.close();
    assert.deepEqual(membersAfter.map((m) => m.eval_id).sort(), beforeIds);

    const newRun = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: registered.eval_set_id,
        max_eval_spend_usd: 5,
        keys_ref: keysRef,
        intent: "recheck",
        named_model: { rec_id: recId, model_id: namedModelId },
        idempotency_key: "recheck-j5-new",
      },
    });
    assert.equal(newRun.statusCode, 200);
    const newReport = await waitForRunComplete(
      app,
      projectId,
      (newRun.json() as { run_id: string }).run_id,
    );
    const newScored = newReport.eval_ids_scored as string[];
    assert.ok(newScored.includes(registered.eval_id));
    for (const id of oldEvalIds) {
      assert.ok(newScored.includes(id), `old eval ${id} missing from new recheck`);
    }
  });
});
