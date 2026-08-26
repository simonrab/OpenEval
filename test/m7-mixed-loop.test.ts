import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { signMarkToken } from "../src/mark/tokens.js";
import { ErrorCode } from "../src/tools/types.js";
import {
  acceptToken,
  authHeaders,
  createTestApp,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

const SAMPLE_JSON = '{"line_items":[{"sku":"a","qty":1}],"total_cents":100}';

describe("M7 mixed-job loop", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-m7-loop-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await createTestApp(sqlitePath);
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("generate → accept → mark → run → recommend → approve → failure → recheck old/new", async () => {
    const gen = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "Return JSON with line_items and a warm friendly tone",
        sample_files: [1, 2, 3, 4, 5].map((n) => ({
          path: `fixtures/inv-00${n}.json`,
          content: SAMPLE_JSON,
        })),
        idempotency_key: "m7-loop-gen",
      },
    });
    assert.equal(gen.statusCode, 200);
    const suite = gen.json() as {
      project_id: string;
      eval_set_id: string;
      n_code: number;
      n_person: number;
      next_action: { args: { after_accept_tool?: string } };
    };
    assert.ok(suite.n_code > 0);
    assert.ok(suite.n_person > 0);
    assert.equal(suite.next_action.args.after_accept_tool, "queue_for_labeling");

    const db = new Database(sqlitePath);
    const allEvals = db
      .prepare(
        `SELECT e.id AS eval_id, e.score_how FROM eval_set_members m
         JOIN evals e ON e.id = m.eval_id WHERE m.eval_set_id = ?`,
      )
      .all(suite.eval_set_id) as Array<{ eval_id: string; score_how: string }>;
    const codeIds = allEvals.filter((e) => e.score_how === "code").map((e) => e.eval_id);
    const personIds = allEvals.filter((e) => e.score_how === "person").map((e) => e.eval_id);
    const keysRef = await storeCustomerKey(db, suite.project_id);
    db.close();
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
        idempotency_key: "m7-loop-queue",
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
    const personEvalId = personIds[0]!;
    const markBody = {
      eval_set_id: suite.eval_set_id,
      eval_id: personEvalId,
      token: markToken,
      action: "submit",
      rubric_tone: "pass",
      rubric_length: "pass",
    };
    const markA = await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: { ...markBody, person_id: marker1 },
    });
    assert.equal(markA.statusCode, 200);
    const markB = await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: { ...markBody, person_id: marker2 },
    });
    assert.equal(markB.statusCode, 200);
    assert.equal((markB.json() as { trusted: boolean }).trusted, true);

    const runRes = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: suite.project_id,
        eval_set_id: suite.eval_set_id,
        models: ["openai/gpt-4o-mini", "google/gemini-flash-1.5"],
        max_eval_spend_usd: 5,
        keys_ref: keysRef,
        idempotency_key: "m7-loop-run",
      },
    });
    assert.equal(runRes.statusCode, 200);
    const { run_id: runId } = runRes.json() as { run_id: string };
    await waitForRunComplete(app, suite.project_id, runId);

    const recRes = await app.inject({
      method: "POST",
      url: "/v1/tools/recommend_models",
      headers: authHeaders(),
      payload: {
        project_id: suite.project_id,
        eval_set_id: suite.eval_set_id,
        run_id: runId,
        intent: "new_feature",
        idempotency_key: "m7-loop-rec",
      },
    });
    assert.equal(recRes.statusCode, 200);
    const rec = recRes.json() as {
      recommendation_id: string;
      named_model: { id: string };
      approve_url: string;
    };
    assert.match(rec.approve_url, /\/approve\?/);

    const approvePage = await app.inject({
      method: "GET",
      url: rec.approve_url.replace("http://test.local", ""),
    });
    assert.equal(approvePage.statusCode, 200);
    assert.match(approvePage.body, new RegExp(rec.named_model.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const approved = await app.inject({
      method: "POST",
      url: "/approve",
      headers: { "content-type": "application/json" },
      payload: {
        recommendation_id: rec.recommendation_id,
        token: new URL(rec.approve_url).searchParams.get("token"),
        decision: "approved",
      },
    });
    assert.equal((approved.json() as { live_traffic_changed: boolean }).live_traffic_changed, false);

    const registered = await app.inject({
      method: "POST",
      url: "/v1/tools/register_failure",
      headers: authHeaders(),
      payload: {
        project_id: suite.project_id,
        eval_set_id: suite.eval_set_id,
        input: { prompt: "missing invoice_id" },
        why_bad: "invoice_id missing",
        program_check: {
          kind: "field_equals",
          expected: { path: "invoice_id", exists: true },
        },
        idempotency_key: "m7-loop-fail",
      },
    });
    assert.equal(registered.statusCode, 200);
    const failure = registered.json() as {
      eval_id: string;
      eval_set_id: string;
    };
    assert.notEqual(failure.eval_set_id, suite.eval_set_id);

    const oldRecheck = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: suite.project_id,
        eval_set_id: suite.eval_set_id,
        max_eval_spend_usd: 5,
        keys_ref: keysRef,
        intent: "recheck",
        named_model: {
          rec_id: rec.recommendation_id,
          model_id: rec.named_model.id,
        },
        idempotency_key: "m7-recheck-old",
      },
    });
    assert.equal(oldRecheck.statusCode, 200);
    const oldReport = await waitForRunComplete(
      app,
      suite.project_id,
      (oldRecheck.json() as { run_id: string }).run_id,
    );
    assert.equal(oldReport.ci_exit, 0);
    assert.ok(!(oldReport.eval_ids_scored as string[]).includes(failure.eval_id));

    const newRecheck = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: suite.project_id,
        eval_set_id: failure.eval_set_id,
        max_eval_spend_usd: 5,
        keys_ref: keysRef,
        intent: "recheck",
        named_model: {
          rec_id: rec.recommendation_id,
          model_id: rec.named_model.id,
        },
        idempotency_key: "m7-recheck-new",
      },
    });
    assert.equal(newRecheck.statusCode, 200);
    const newReport = await waitForRunComplete(
      app,
      suite.project_id,
      (newRecheck.json() as { run_id: string }).run_id,
    );
    assert.notEqual(newReport.ci_exit, 0);
    assert.ok((newReport.eval_ids_scored as string[]).includes(failure.eval_id));
    assert.equal(newReport.code, ErrorCode.need_new_model);
  });
});
