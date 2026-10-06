import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { dispatch, type ToolContext } from "../src/dispatch.js";
import { createEvalSetVersion1, type DraftEval } from "../src/eval-set.js";
import { newJobId } from "../src/ids.js";
import { judgeStatus, listCalibrationItems } from "../src/judge/store.js";
import { ensureProjectPeople, submitMark } from "../src/mark/store.js";
import type { ChatCompletionResult, OpenRouterClient } from "../src/runner/openrouter.js";
import { processRun } from "../src/runner/worker.js";
import { ErrorCode } from "../src/tools/types.js";
import { insertProject } from "./helpers/optimizer-fixtures.js";
import { storeCustomerKey, TEST_API_KEY } from "./helpers/run-fixtures.js";

type Body = Record<string, unknown>;

const JUDGE_MODEL = "judge/model";

/** Judge replies by output text. Candidate models reply by model id. */
function mockClient(judgeReply: (output: string) => string, judgeCost = 0.01) {
  const calls = { judge: 0, model: 0 };
  const client: OpenRouterClient = {
    async chatCompletion({ model, prompt }): Promise<ChatCompletionResult> {
      if (model === JUDGE_MODEL) {
        calls.judge += 1;
        const output = prompt.split("<output>\n")[1]!.split("\n</output>")[0]!;
        return { content: judgeReply(output), time_ms: 1, cost_usd: judgeCost, cost_source: "provider" };
      }
      calls.model += 1;
      const content = model.includes("good") ? "GOOD reply" : "BAD reply";
      return { content, time_ms: 1, cost_usd: 0.02, cost_source: "provider" };
    },
  };
  return { client, calls };
}

const agreeingJudge = (output: string) =>
  JSON.stringify({ verdict: output.startsWith("GOOD") ? "pass" : "fail", reason: "checked" });

/** n trusted person evals. Even items: people passed a GOOD output. Odd: people failed a BAD one. */
function seedPersonSet(
  db: Database.Database,
  projectId: string,
  n: number,
  verdictOf: (i: number) => "pass" | "fail" = (i) => (i % 2 === 0 ? "pass" : "fail"),
): { evalSetId: string; evalIds: string[] } {
  const jobId = newJobId();
  db.prepare(
    `INSERT INTO jobs (id, project_id, description, limits, created_at) VALUES (?, ?, ?, NULL, ?)`,
  ).run(
    jobId,
    projectId,
    JSON.stringify({ how_it_should_behave: "warm tone", success: "helpful reply", must_never: "forbidden-word" }),
    new Date().toISOString(),
  );
  const drafts: DraftEval[] = Array.from({ length: n }, (_, i) => ({
    title: `person ${i}`,
    score_how: "person",
    status: "draft",
    program_check: null,
    input_truncated: `question ${i}`,
    form_type: "pass_fail",
  }));
  const created = createEvalSetVersion1(db, { projectId, jobId, drafts });
  const trust = db.prepare(
    `UPDATE evals SET status = 'trusted', trusted_mark = ?, trusted_output = ? WHERE id = ?`,
  );
  created.evals.forEach((ev, i) => {
    const verdict = verdictOf(i);
    trust.run(
      JSON.stringify({ form_type: "pass_fail", pass_fail: verdict }),
      `${verdict === "pass" ? "GOOD" : "BAD"} answer ${i}`,
      ev.eval_id,
    );
  });
  return { evalSetId: created.evalSetId, evalIds: created.evals.map((e) => e.eval_id) };
}

describe("calibrated model judge", () => {
  let dir: string;
  let db: Database.Database;
  let projectId: string;
  let keysRef: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openeval-judge-"));
    db = openDb(join(dir, "openeval.sqlite"));
    projectId = insertProject(db);
    keysRef = await storeCustomerKey(db, projectId);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function ctx(client?: OpenRouterClient, extra: Partial<ToolContext> = {}): ToolContext {
    return { db, apiKey: TEST_API_KEY, baseUrl: "http://test.local", openRouter: client, ...extra };
  }

  async function call(name: string, body: Body, c: ToolContext = ctx()) {
    const res = await dispatch(name, body, c);
    return { status: res.status, body: res.body as Body };
  }

  async function configure(evalSetId: string, extra: Body = {}, key = "cfg-1") {
    return call("configure_judge", {
      project_id: projectId,
      eval_set_id: evalSetId,
      judge_model: JUDGE_MODEL,
      idempotency_key: key,
      ...extra,
    });
  }

  async function calibrate(evalSetId: string, client: OpenRouterClient, extra: Body = {}, key = "cal-1") {
    return call(
      "calibrate_judge",
      {
        project_id: projectId,
        eval_set_id: evalSetId,
        keys_ref: keysRef,
        max_eval_spend_usd: 5,
        idempotency_key: key,
        ...extra,
      },
      ctx(client),
    );
  }

  it("configure_judge stores an uncalibrated judge with a rubric from the job", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 4);
    const res = await configure(evalSetId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "uncalibrated");
    assert.equal(res.body.rubric_source, "job");
    assert.equal(res.body.n_human_marked, 4);
    assert.equal((res.body.next_action as Body).tool, "calibrate_judge");
    const row = db.prepare(`SELECT rubric FROM judges`).get() as { rubric: string };
    assert.match(row.rubric, /warm tone/);
    assert.deepEqual((await configure(evalSetId)).body, res.body);
  });

  it("calibrate_judge asks for configure_judge first", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 4);
    const res = await calibrate(evalSetId, mockClient(agreeingJudge).client);
    assert.equal(res.status, 400);
    assert.equal((res.body.next_action as Body).tool, "configure_judge");
  });

  it("trusts a judge that agrees with people on held-out marks", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 80);
    await configure(evalSetId);
    const { client, calls } = mockClient(agreeingJudge);
    const res = await calibrate(evalSetId, client);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const b = res.body;
    assert.equal(b.status, "trusted");
    assert.equal(b.accuracy, 1);
    assert.equal(b.kappa, 1);
    assert.equal(Number(b.n_train) + Number(b.n_test), 80);
    assert.ok(Number(b.n_test) >= 20);
    assert.equal(calls.judge, b.n_test, "the judge runs on the test part only");
    assert.ok(Math.abs(Number(b.cost_usd) - Number(b.n_test) * 0.01) < 1e-9);
    assert.deepEqual(b.thresholds, { min_n_test: 20, min_accuracy: 0.85, min_kappa: 0.6 });
    assert.equal((b.next_action as Body).tool, "run_evals");
    assert.equal(judgeStatus(db, evalSetId).status, "trusted");
  });

  it("keeps the split stable across calls", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 80);
    await configure(evalSetId);
    const a = await calibrate(evalSetId, mockClient(agreeingJudge).client, {}, "cal-a");
    const b = await calibrate(evalSetId, mockClient(agreeingJudge).client, {}, "cal-b");
    assert.equal(a.body.n_test, b.body.n_test);
    assert.notEqual(a.body.calibration_id, b.body.calibration_id);
  });

  it("does not trust a judge that always says pass", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 80);
    await configure(evalSetId);
    const res = await calibrate(evalSetId, mockClient(() => '{"verdict":"pass","reason":"ok"}').client);
    assert.equal(res.body.status, "uncalibrated");
    assert.equal(res.body.kappa, 0);
    assert.match(String(res.body.reason), /agrees with people/);
    assert.equal((res.body.next_action as Body).tool, "configure_judge");
    assert.equal(judgeStatus(db, evalSetId).status, "uncalibrated");
  });

  it("counts a reply that is not a verdict as a disagreement", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 80);
    await configure(evalSetId);
    let n = 0;
    const res = await calibrate(
      evalSetId,
      mockClient((output) => {
        n += 1;
        return n % 2 === 0 ? "I cannot say" : agreeingJudge(output);
      }).client,
    );
    assert.equal(res.body.status, "uncalibrated");
    assert.ok(Number(res.body.n_judge_errors) > 0);
    assert.equal(Number(res.body.n_agree) + Number(res.body.n_judge_errors), res.body.n_test);
  });

  it("stays uncalibrated with too few marks, spends nothing, and asks for marks", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 10);
    await configure(evalSetId);
    const { client, calls } = mockClient(agreeingJudge);
    const res = await calibrate(evalSetId, client);
    assert.equal(res.body.status, "uncalibrated");
    assert.match(String(res.body.reason), /Need 20/);
    assert.equal(calls.judge, 0);
    assert.equal(res.body.cost_usd, 0);
    assert.equal(res.body.accuracy, null);
    assert.equal((res.body.next_action as Body).tool, "queue_for_labeling");
  });

  it("stops at the spend cap and stays uncalibrated", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 80);
    await configure(evalSetId);
    const { client, calls } = mockClient(agreeingJudge, 0.05);
    const res = await calibrate(evalSetId, client, { max_eval_spend_usd: 0.2 });
    assert.equal(res.body.status, "uncalibrated");
    assert.match(String(res.body.reason), /spend cap/);
    assert.ok(calls.judge < Number(res.body.n_test));
    assert.ok(Number(res.body.cost_usd) <= 0.2 + 0.05 + 1e-9);
    const zero = await calibrate(evalSetId, client, { max_eval_spend_usd: 0 }, "cal-zero");
    assert.equal(zero.status, 400);
    assert.equal(zero.body.code, ErrorCode.COST_CAP_REQUIRED);
  });

  it("requires keys_ref", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 4);
    await configure(evalSetId);
    const res = await calibrate(evalSetId, mockClient(agreeingJudge).client, { keys_ref: null });
    assert.equal(res.status, 400);
    assert.match(String(res.body.message), /keys_ref/);
  });

  it("loses trust when the judge config changes", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 80);
    await configure(evalSetId);
    await calibrate(evalSetId, mockClient(agreeingJudge).client);
    assert.equal(judgeStatus(db, evalSetId).status, "trusted");

    const same = await configure(evalSetId, {}, "cfg-same");
    assert.equal(same.body.status, "trusted");

    const changed = await configure(evalSetId, { rubric: "Only short replies pass." }, "cfg-2");
    assert.equal(changed.body.status, "uncalibrated");
    assert.equal(changed.body.rubric_source, "input");
    assert.match(String(changed.body.reason), /changed/);
    assert.equal(judgeStatus(db, evalSetId).status, "uncalibrated");

    await configure(evalSetId, { settings: { temperature: 0.7 } }, "cfg-3");
    assert.equal(judgeStatus(db, evalSetId).status, "uncalibrated");
  });

  it("goes stale when new human marks arrive", async () => {
    const { evalSetId, evalIds } = seedPersonSet(db, projectId, 80);
    await configure(evalSetId);
    await calibrate(evalSetId, mockClient(agreeingJudge).client);
    db.prepare(`UPDATE evals SET trusted_output = 'GOOD changed' WHERE id = ?`).run(evalIds[0]);
    const status = judgeStatus(db, evalSetId);
    assert.equal(status.status, "stale");
    const again = await calibrate(evalSetId, mockClient(agreeingJudge).client, {}, "cal-2");
    assert.equal(again.body.status, "trusted");
    assert.equal(judgeStatus(db, evalSetId).status, "trusted");
  });

  async function startRun(evalSetId: string, key: string): Promise<string> {
    const res = await call("run_evals", {
      project_id: projectId,
      eval_set_id: evalSetId,
      models: ["m/good", "m/bad"],
      reps: 1,
      keys_ref: keysRef,
      max_eval_spend_usd: 50,
      idempotency_key: key,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return String(res.body.run_id);
  }

  it("worker grades person evals with a trusted judge and tells models apart", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 80);
    await configure(evalSetId);
    const { client, calls } = mockClient(agreeingJudge);
    await calibrate(evalSetId, client);
    const judgeCallsBefore = calls.judge;

    const runId = await startRun(evalSetId, "run-judge");
    await processRun({ db, apiKey: TEST_API_KEY, openRouter: client, retry: { attempts: 1, baseDelayMs: 0 } }, runId);
    assert.equal(calls.judge - judgeCallsBefore, 160);

    const rows = db
      .prepare(`SELECT model_id, passed, reason_short, judge_cost_usd, cost_usd FROM run_results WHERE run_id = ?`)
      .all(runId) as Array<{ model_id: string; passed: number; reason_short: string; judge_cost_usd: number; cost_usd: number }>;
    assert.ok(rows.filter((r) => r.model_id === "m/good").every((r) => r.passed === 1 && r.reason_short === "judge pass"));
    assert.ok(rows.filter((r) => r.model_id === "m/bad").every((r) => r.passed === 0 && r.reason_short.startsWith("judge fail")));
    assert.ok(rows.every((r) => r.judge_cost_usd === 0.01 && r.cost_usd === 0.02));

    const report = await call("get_eval_report", { project_id: projectId, run_id: runId });
    const summary = report.body.summary as Body;
    assert.equal(summary.n_person_evals_not_graded, 0);
    assert.equal(summary.grader_advice, null);
    assert.ok(Math.abs(Number(summary.cost_usd) - 160 * 0.03) < 1e-6, "run spend includes judge cost");
  });

  it("worker flags reused marks when the judge is not trusted", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 12);
    await configure(evalSetId);
    const { client, calls } = mockClient(agreeingJudge);
    const runId = await startRun(evalSetId, "run-legacy");
    await processRun({ db, apiKey: TEST_API_KEY, openRouter: client, retry: { attempts: 1, baseDelayMs: 0 } }, runId);
    assert.equal(calls.judge, 0);
    const rows = db.prepare(`SELECT reason_short, judge_cost_usd FROM run_results WHERE run_id = ?`).all(runId) as Array<{
      reason_short: string;
      judge_cost_usd: number | null;
    }>;
    assert.ok(rows.every((r) => r.reason_short.startsWith("person mark reused") && r.judge_cost_usd === null));
    const report = await call("get_eval_report", { project_id: projectId, run_id: runId });
    const summary = report.body.summary as Body;
    assert.equal(summary.n_person_evals_not_graded, 12);
    assert.match(String(summary.grader_advice), /did not grade the output/);
    assert.match(String(summary.grader_advice), /not trusted/);
  });

  it("recommend_models reports person evals that were not graded", async () => {
    const { evalSetId } = seedPersonSet(db, projectId, 12, () => "pass");
    const { client } = mockClient(agreeingJudge);
    const runId = await startRun(evalSetId, "run-rec");
    await processRun({ db, apiKey: TEST_API_KEY, openRouter: client, retry: { attempts: 1, baseDelayMs: 0 } }, runId);
    const rec = await call("recommend_models", {
      project_id: projectId,
      eval_set_id: evalSetId,
      run_id: runId,
      intent: "new_feature",
      idempotency_key: "rec-1",
    });
    assert.equal(rec.status, 200, JSON.stringify(rec.body));
    assert.equal(rec.body.n_person_evals_not_graded, 12);
    assert.match(String(rec.body.grader_advice), /configure_judge/);
    assert.equal((rec.body.next_action as Body).ask_human, "open approve_url");
  });

  function harnessOutputs(evalIds: string[], text: string) {
    return evalIds.map((eval_id) => ({ eval_id, output: text }));
  }

  it("submit_outputs uses the trusted judge only with keys_ref", async () => {
    const { evalSetId, evalIds } = seedPersonSet(db, projectId, 80);
    await configure(evalSetId);
    const { client, calls } = mockClient(agreeingJudge);
    await calibrate(evalSetId, client);
    const before = calls.judge;

    const legacy = await call(
      "submit_outputs",
      {
        project_id: projectId,
        eval_set_id: evalSetId,
        candidate: { id: "harness#a" },
        outputs: harnessOutputs(evalIds, "BAD harness reply"),
        idempotency_key: "sub-legacy",
      },
      ctx(client),
    );
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.equal(legacy.body.n_person_evals_not_graded, 80);
    assert.match(String(legacy.body.grader_advice), /keys_ref/);
    assert.equal(calls.judge, before);

    const judged = await call(
      "submit_outputs",
      {
        project_id: projectId,
        eval_set_id: evalSetId,
        candidate: { id: "harness#b" },
        outputs: harnessOutputs(evalIds, "BAD harness reply"),
        keys_ref: keysRef,
        max_eval_spend_usd: 5,
        idempotency_key: "sub-judged",
      },
      ctx(client),
    );
    assert.equal(judged.status, 200, JSON.stringify(judged.body));
    assert.equal(judged.body.n_person_evals_not_graded, 0);
    assert.equal(judged.body.n_scored, 80);
    assert.equal(calls.judge - before, 80);
    const passed = db
      .prepare(`SELECT SUM(passed) AS n FROM run_results WHERE run_id = ?`)
      .get(judged.body.run_id) as { n: number };
    assert.equal(passed.n, 0, "the judge fails every BAD reply, also where people passed a GOOD one");
    const spend = db.prepare(`SELECT spend_usd FROM runs WHERE id = ?`).get(judged.body.run_id) as { spend_usd: number };
    assert.ok(Math.abs(spend.spend_usd - 0.8) < 1e-9);
  });

  it("submit_outputs needs a spend cap with keys_ref and honors it", async () => {
    const { evalSetId, evalIds } = seedPersonSet(db, projectId, 80);
    await configure(evalSetId);
    const { client } = mockClient(agreeingJudge, 0.05);
    await calibrate(evalSetId, client, { max_eval_spend_usd: 50 });
    assert.equal(judgeStatus(db, evalSetId).status, "trusted");
    const base = {
      project_id: projectId,
      eval_set_id: evalSetId,
      candidate: { id: "harness#c" },
      outputs: harnessOutputs(evalIds, "GOOD reply"),
      keys_ref: keysRef,
    };
    const noCap = await call("submit_outputs", { ...base, idempotency_key: "sub-nocap" }, ctx(client));
    assert.equal(noCap.status, 400);
    assert.equal(noCap.body.code, ErrorCode.INVALID_INPUT);

    const capped = await call(
      "submit_outputs",
      { ...base, max_eval_spend_usd: 0.5, idempotency_key: "sub-cap" },
      ctx(client),
    );
    assert.equal(capped.status, 200, JSON.stringify(capped.body));
    assert.ok(Number(capped.body.n_error) > 0, "outputs past the cap are not scored");
    const spend = db.prepare(`SELECT spend_usd FROM runs WHERE id = ?`).get(capped.body.run_id) as { spend_usd: number };
    assert.ok(spend.spend_usd <= 0.5 + 0.05 * 4 + 1e-9);
  });
});

describe("mark screen outputs for calibration", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openeval-judge-mark-"));
    db = openDb(join(dir, "openeval.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the output people marked and uses it as a calibration item", async () => {
    const projectId = insertProject(db);
    const jobId = newJobId();
    db.prepare(
      `INSERT INTO jobs (id, project_id, description, limits, created_at) VALUES (?, ?, 'Reply job', NULL, ?)`,
    ).run(jobId, projectId, new Date().toISOString());
    const created = createEvalSetVersion1(db, {
      projectId,
      jobId,
      drafts: [
        { title: "p", score_how: "person", status: "draft", program_check: null, input_truncated: "hi", form_type: "pass_fail" },
      ],
    });
    const evalSetId = created.evalSetId;
    const evalId = created.evals[0]!.eval_id;

    const queued = await dispatch(
      "queue_for_labeling",
      {
        project_id: projectId,
        eval_set_id: evalSetId,
        outputs: [{ eval_id: evalId, output: "Hello! How can I help?" }],
        idempotency_key: "q-1",
      },
      { db, apiKey: TEST_API_KEY },
    );
    assert.equal(queued.status, 200);
    assert.equal((queued.body as Body).n_outputs_shown, 1);

    const people = ensureProjectPeople(db, projectId);
    const m1 = people.find((p) => p.slot === "marker1")!.id;
    const m2 = people.find((p) => p.slot === "marker2")!.id;
    const mark = { form_type: "pass_fail" as const, pass_fail: "fail" as const };
    submitMark(db, { evalSetId, evalId, personId: m1, mark });
    const done = submitMark(db, { evalSetId, evalId, personId: m2, mark });
    assert.equal(done.ok && done.trusted, true);

    const row = db.prepare(`SELECT trusted_output FROM evals WHERE id = ?`).get(evalId) as { trusted_output: string };
    assert.equal(row.trusted_output, "Hello! How can I help?");
    assert.deepEqual(listCalibrationItems(db, evalSetId), [
      { eval_id: evalId, input: "hi", output: "Hello! How can I help?", human: "fail" },
    ]);

    // An output cannot change after people start to mark.
    const later = await dispatch(
      "queue_for_labeling",
      {
        project_id: projectId,
        eval_set_id: evalSetId,
        outputs: [{ eval_id: evalId, output: "other" }],
        idempotency_key: "q-2",
      },
      { db, apiKey: TEST_API_KEY },
    );
    assert.equal((later.body as Body).n_outputs_shown, 0);
  });
});
