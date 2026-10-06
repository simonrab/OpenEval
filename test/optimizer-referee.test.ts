import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { dispatch } from "../src/dispatch.js";
import { copyEvalSetForward } from "../src/eval-set-copy.js";
import { insertDraftEvals } from "../src/eval-set.js";
import { buildApp } from "../src/server.js";
import { ensureEvalSplit } from "../src/splits.js";
import {
  getTrainingFailuresOutputSchema,
  getVerdictOutputSchema,
  parseToolInput,
} from "../src/tools/schema.js";
import { ErrorCode } from "../src/tools/types.js";
import {
  addResults,
  caseDraft,
  insertProject,
  insertRun,
  seedTrustedSet,
} from "./helpers/optimizer-fixtures.js";
import {
  authHeaders,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

type Rep = boolean | "error";
const PASS: Rep[] = [true, true, true];
const FAIL: Rep[] = [false, false, false];

type Verdict = {
  verdict: string;
  reason: string;
  directional: boolean;
  underpowered: boolean;
  advice: string | null;
  n_shared_evals: number;
  train: { n_evals: number; delta: number; ci95: [number, number]; noise_floor: number; n_regressed: number };
  holdout: { n_evals: number; delta: number; ci95: [number, number]; noise_floor: number; n_regressed: number };
  cost_per_call_usd: { baseline: number; candidate: number; delta: number };
  p50_latency_ms: { baseline: number; candidate: number; delta: number };
  session_id: string | null;
  rounds: number | null;
  flat_rounds: number | null;
  plateau: boolean;
  next_action: { tool: string | null; args: Record<string, unknown>; ask_human: string | null };
};

describe("optimizer referee", () => {
  let dir: string;
  let db: Database.Database;
  let projectId: string;
  let evalSetId: string;
  let train: string[];
  let holdout: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openeval-referee-"));
    db = openDb(join(dir, "openeval.sqlite"));
    projectId = insertProject(db);
    evalSetId = seedTrustedSet(db, projectId, 20).evalSetId;
    const split = ensureEvalSplit(db, evalSetId);
    train = [...split.splits].filter(([, s]) => s === "train").map(([id]) => id);
    holdout = [...split.splits].filter(([, s]) => s === "holdout").map(([id]) => id);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One run with base and cand. pattern returns reps per eval. */
  function run(
    base: (id: string) => Rep[],
    cand: (id: string) => Rep[],
    opts: { baseCost?: number; candCost?: number; setId?: string; candTime?: number } = {},
  ): string {
    const setId = opts.setId ?? evalSetId;
    const runId = insertRun(db, { projectId, evalSetId: setId, candidateIds: ["m/a#base", "m/a#cand"] });
    const members = db
      .prepare(`SELECT eval_id FROM eval_set_members WHERE eval_set_id = ?`)
      .all(setId) as Array<{ eval_id: string }>;
    for (const { eval_id: id } of members) {
      addResults(db, runId, "m/a#base", id, base(id), { costUsd: opts.baseCost });
      addResults(db, runId, "m/a#cand", id, cand(id), {
        costUsd: opts.candCost,
        timeMs: opts.candTime,
        output: `out-${id}`,
      });
    }
    return runId;
  }

  async function verdict(runId: string, extra: Record<string, unknown> = {}): Promise<Verdict> {
    const res = await dispatch(
      "get_verdict",
      {
        project_id: projectId,
        baseline_run_id: runId,
        baseline_candidate_id: "m/a#base",
        candidate_run_id: runId,
        candidate_id: "m/a#cand",
        ...extra,
      },
      { db },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    getVerdictOutputSchema.parse(res.body);
    return res.body as Verdict;
  }

  describe("get_training_failures", () => {
    it("lists train failures only and counts holdout in aggregate", async () => {
      const failing = new Set([...train.slice(0, 3), ...holdout.slice(0, 2)]);
      const runId = run(
        () => PASS,
        (id) => (failing.has(id) ? FAIL : id === train[3] ? [true, false, true] : PASS),
      );
      const res = await dispatch(
        "get_training_failures",
        { project_id: projectId, run_id: runId, candidate_id: "m/a#cand" },
        { db },
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const body = getTrainingFailuresOutputSchema.parse(res.body);
      assert.equal(body.directional, false);
      assert.deepEqual(
        body.failures.map((f) => f.eval_id).sort(),
        [...train.slice(0, 4)].sort(),
      );
      assert.equal(body.train.n_evals, 14);
      assert.equal(body.train.n_fail, 4);
      assert.equal(body.train.n_flaky, 1);
      assert.equal(body.train.n_pass, 10);
      assert.deepEqual(body.holdout, { n_evals: 6, n_pass: 4, n_fail: 2, n_error: 0 });
      const flaky = body.failures.find((f) => f.eval_id === train[3])!;
      assert.equal(flaky.flaky, true);
      assert.equal(flaky.reps.length, 3);
      assert.equal(flaky.reps[1]!.passed, false);
      assert.equal(flaky.reps[1]!.output, `out-${train[3]}`);
      assert.equal(flaky.reps[0]!.output, null);
      assert.match(flaky.input, /^input-\d\d-x$/);

      const text = JSON.stringify(res.body);
      for (const id of holdout) {
        assert.equal(text.includes(id), false, "holdout eval id leaked");
        assert.equal(text.includes(`out-${id}`), false, "holdout output leaked");
      }
      const holdoutRows = db
        .prepare(`SELECT title, input_truncated FROM evals WHERE id IN (${holdout.map(() => "?").join(",")})`)
        .all(...holdout) as Array<{ title: string; input_truncated: string }>;
      for (const row of holdoutRows) {
        assert.equal(text.includes(row.title), false, "holdout title leaked");
        assert.equal(text.includes(row.input_truncated), false, "holdout input leaked");
      }
    });

    it("pages the failures", async () => {
      const failing = new Set(train.slice(0, 5));
      const runId = run(() => PASS, (id) => (failing.has(id) ? FAIL : PASS));
      const first = await dispatch(
        "get_training_failures",
        { project_id: projectId, run_id: runId, candidate_id: "m/a#cand", limit: 2 },
        { db },
      );
      const page1 = getTrainingFailuresOutputSchema.parse(first.body);
      assert.equal(page1.failures.length, 2);
      assert.equal(page1.truncated, true);
      assert.equal(page1.next_action.tool, "get_training_failures");
      const all = [...page1.failures.map((f) => f.eval_id)];
      let cursor = page1.next_cursor;
      while (cursor) {
        const next = await dispatch(
          "get_training_failures",
          { project_id: projectId, run_id: runId, candidate_id: "m/a#cand", limit: 2, cursor },
          { db },
        );
        const page = getTrainingFailuresOutputSchema.parse(next.body);
        all.push(...page.failures.map((f) => f.eval_id));
        cursor = page.next_cursor;
      }
      assert.deepEqual(all.sort(), [...failing].sort());
    });

    it("truncates a long output", async () => {
      const runId = run(() => PASS, (id) => (id === train[0] ? FAIL : PASS));
      db.prepare(`UPDATE run_results SET output_truncated = ? WHERE eval_id = ?`).run("y".repeat(4000), train[0]);
      const res = await dispatch(
        "get_training_failures",
        { project_id: projectId, run_id: runId, candidate_id: "m/a#cand" },
        { db },
      );
      const body = getTrainingFailuresOutputSchema.parse(res.body);
      const out = body.failures[0]!.reps[0]!.output!;
      assert.ok(out.length <= 1000);
      assert.ok(out.endsWith("..."));
    });

    it("rejects a candidate that is not in the run", async () => {
      const runId = run(() => PASS, () => PASS);
      const res = await dispatch(
        "get_training_failures",
        { project_id: projectId, run_id: runId, candidate_id: "m/zzz" },
        { db },
      );
      assert.equal(res.status, 404);
    });
  });

  describe("get_verdict", () => {
    it("keeps a change that improves holdout beyond noise", async () => {
      const fixed = new Set([...train.slice(0, 7), ...holdout.slice(0, 3)]);
      const runId = run((id) => (fixed.has(id) ? FAIL : PASS), () => PASS);
      const v = await verdict(runId);
      assert.equal(v.verdict, "keep");
      assert.ok(v.holdout.ci95[0] > 0);
      assert.equal(v.holdout.n_evals, 6);
      assert.equal(v.train.n_evals, 14);
      assert.equal(v.directional, false);
      assert.equal(v.next_action.tool, null);
      assert.equal(v.next_action.ask_human, null);
      assert.equal(v.next_action.args.change, "keep");
      assert.equal(v.rounds, null);
    });

    it("reverts a change that improves train but not holdout", async () => {
      const trainFixed = new Set(train.slice(0, 7));
      const holdoutBad = new Set(holdout.slice(0, 3));
      const runId = run(
        (id) => (trainFixed.has(id) || holdoutBad.has(id) ? FAIL : PASS),
        (id) => (holdoutBad.has(id) ? FAIL : PASS),
      );
      const v = await verdict(runId);
      assert.equal(v.verdict, "revert_overfit");
      assert.ok(v.train.ci95[0] > 0);
      assert.equal(v.holdout.delta, 0);
      assert.equal(v.next_action.args.change, "revert");
    });

    it("reverts when a holdout eval goes from pass on every rep to fail on every rep", async () => {
      const runId = run(() => PASS, (id) => (id === holdout[0] ? FAIL : PASS));
      const v = await verdict(runId);
      assert.equal(v.verdict, "revert_regressed");
      assert.equal(v.holdout.n_regressed, 1);
    });

    it("reports within_noise for a small flaky change", async () => {
      const runId = run(() => PASS, (id) => (id === train[0] ? [true, false, true] : PASS));
      const v = await verdict(runId);
      assert.equal(v.verdict, "within_noise");
      assert.ok(v.train.ci95[0] < 0 && v.train.ci95[1] > 0);
      assert.equal(v.next_action.args.change, "revert");
    });

    it("says not_comparable when a shared eval has no score", async () => {
      const runId = run(() => PASS, (id) => (id === train[0] ? ["error", "error", "error"] : PASS));
      const v = await verdict(runId);
      assert.equal(v.verdict, "not_comparable");
      assert.match(v.reason, /no score/);
      assert.equal(v.next_action.tool, "run_evals");
    });

    it("says not_comparable when a run is not done", async () => {
      const runId = run(() => PASS, () => PASS);
      db.prepare(`UPDATE runs SET status = 'running' WHERE id = ?`).run(runId);
      const v = await verdict(runId);
      assert.equal(v.verdict, "not_comparable");
      assert.equal(v.next_action.tool, "get_eval_report");
    });

    it("keeps a cheaper setup on the cost objective when holdout holds", async () => {
      const runId = run(() => PASS, () => PASS, { baseCost: 0.02, candCost: 0.01, candTime: 50 });
      const quality = await verdict(runId);
      assert.equal(quality.verdict, "within_noise");
      const cost = await verdict(runId, { objective: "cost" });
      assert.equal(cost.verdict, "keep");
      assert.ok(Math.abs(cost.cost_per_call_usd.delta + 0.01) < 1e-9);
      assert.equal(cost.p50_latency_ms.delta, -50);
    });

    it("does not keep a cheaper setup that regresses holdout", async () => {
      const bad = new Set(holdout.slice(0, 4));
      const runId = run(() => PASS, (id) => (bad.has(id) ? FAIL : PASS), {
        baseCost: 0.02,
        candCost: 0.01,
      });
      const v = await verdict(runId, { objective: "cost" });
      assert.equal(v.verdict, "revert_regressed");
    });

    it("flags an underpowered comparison", async () => {
      const runId = run(() => PASS, (id) => (id === train[0] ? [true, false, true] : PASS));
      const v = await verdict(runId, { min_effect: 0.01 });
      assert.equal(v.underpowered, true);
      assert.match(v.advice ?? "", /reps/);
      const loose = await verdict(runId, { min_effect: 0.9 });
      assert.equal(loose.underpowered, false);
      assert.equal(loose.advice, null);
    });

    it("is directional when the eval set has no split", async () => {
      const small = seedTrustedSet(db, projectId, 8).evalSetId;
      const runId = run(() => PASS, () => PASS, { setId: small });
      const v = await verdict(runId);
      assert.equal(v.directional, true);
      assert.equal(v.holdout.n_evals, 0);
      assert.equal(v.train.n_evals, 8);
    });

    it("compares a copy-forward descendant on the shared evals only", async () => {
      const copied = copyEvalSetForward(db, { projectId, sourceEvalSetId: evalSetId });
      const [added] = insertDraftEvals(db, copied.newEvalSetId, [caseDraft(200)]);
      db.prepare(`UPDATE evals SET status = 'trusted' WHERE id = ?`).run(added!.eval_id);
      const baseRun = insertRun(db, { projectId, evalSetId, candidateIds: ["m/a#base"] });
      for (const id of [...train, ...holdout]) addResults(db, baseRun, "m/a#base", id, PASS);
      const candRun = insertRun(db, { projectId, evalSetId: copied.newEvalSetId, candidateIds: ["m/a#cand"] });
      for (const id of [...train, ...holdout, added!.eval_id]) addResults(db, candRun, "m/a#cand", id, PASS);
      const res = await dispatch(
        "get_verdict",
        {
          project_id: projectId,
          baseline_run_id: baseRun,
          baseline_candidate_id: "m/a#base",
          candidate_run_id: candRun,
          candidate_id: "m/a#cand",
        },
        { db },
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const v = res.body as Verdict;
      assert.equal(v.n_shared_evals, 20);
      assert.equal(v.verdict, "within_noise");
    });

    it("rejects runs on unrelated eval sets", async () => {
      const other = seedTrustedSet(db, projectId, 12).evalSetId;
      const a = run(() => PASS, () => PASS);
      const b = run(() => PASS, () => PASS, { setId: other });
      const res = await dispatch(
        "get_verdict",
        {
          project_id: projectId,
          baseline_run_id: a,
          baseline_candidate_id: "m/a#base",
          candidate_run_id: b,
          candidate_id: "m/a#cand",
        },
        { db },
      );
      assert.equal(res.status, 400);
      assert.equal((res.body as { code: string }).code, ErrorCode.INVALID_INPUT);
    });

    it("needs idempotency_key when it records a round", () => {
      const body = {
        project_id: projectId,
        baseline_run_id: "run_1",
        baseline_candidate_id: "m/a",
        candidate_run_id: "run_2",
        candidate_id: "m/a",
        session_id: "ses_1",
      };
      const parsed = parseToolInput("get_verdict", body);
      assert.equal(parsed.ok, false);
      assert.equal(!parsed.ok && parsed.error.code, ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
      const { session_id: _s, ...readOnly } = body;
      assert.equal(parseToolInput("get_verdict", readOnly).ok, true);
    });

    it("records rounds and reports a plateau after 3 flat rounds", async () => {
      const flatRun = run(() => PASS, () => PASS);
      const keepSet = new Set([...train.slice(0, 7), ...holdout.slice(0, 3)]);
      const keepRun = run((id) => (keepSet.has(id) ? FAIL : PASS), () => PASS);
      const call = (runId: string, key: string) =>
        verdict(runId, { session_id: "ses_a", idempotency_key: key });

      const r1 = await call(flatRun, "k1");
      assert.deepEqual([r1.rounds, r1.flat_rounds, r1.plateau], [1, 1, false]);
      const r2 = await call(keepRun, "k2");
      assert.deepEqual([r2.rounds, r2.flat_rounds, r2.plateau], [2, 0, false]);
      await call(flatRun, "k3");
      const again = await call(flatRun, "k3");
      assert.equal(again.rounds, 3);
      const r4 = await call(flatRun, "k4");
      assert.deepEqual([r4.rounds, r4.flat_rounds, r4.plateau], [4, 2, false]);
      assert.equal(r4.next_action.ask_human, null);
      const r5 = await call(flatRun, "k5");
      assert.deepEqual([r5.rounds, r5.flat_rounds, r5.plateau], [5, 3, true]);
      assert.equal(r5.next_action.ask_human, "review the optimizer branch");
      assert.equal(r5.next_action.tool, null);

      const other = await verdict(flatRun, { session_id: "ses_b", idempotency_key: "k6" });
      assert.equal(other.rounds, 1);
    });

    it("never returns holdout eval ids, titles, or reasons", async () => {
      const bad = new Set(holdout.slice(0, 2));
      const runId = run(() => PASS, (id) => (bad.has(id) ? FAIL : PASS));
      const v = await verdict(runId, { session_id: "ses_x", idempotency_key: "kx" });
      const text = JSON.stringify(v);
      for (const id of holdout) {
        assert.equal(text.includes(id), false);
        assert.equal(text.includes(`out-${id}`), false);
      }
      assert.equal(text.includes("title-"), false);
      assert.equal(text.includes("input-"), false);
      assert.equal(text.includes("wrong answer"), false);
    });
  });
});

describe("optimizer referee end to end", () => {
  let app: FastifyInstance;
  let dir: string;
  let projectId: string;
  let evalSetId: string;
  let keysRef: string;
  let holdoutInputs: Set<string>;
  let trainInputs: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openeval-referee-e2e-"));
    const sqlitePath = join(dir, "openeval.sqlite");
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: {
        async chatCompletion(input) {
          // v1 fails on 3 train inputs. v2 fixes them and breaks the holdout.
          const isHoldout = holdoutInputs.has(input.prompt);
          const brokenByV1 = trainInputs.slice(0, 3).includes(input.prompt);
          const bad =
            input.systemPrompt === "v2" ? isHoldout : brokenByV1;
          return {
            content: bad ? `BAD ${input.prompt}` : `fine ${input.prompt}`,
            time_ms: 10,
            cost_usd: 0.001,
            cost_source: "provider",
          };
        },
      },
    });
    const proj = await app.inject({ method: "POST", url: "/v1/projects", headers: authHeaders(), payload: {} });
    projectId = (proj.json() as { project_id: string }).project_id;
    const db = openDb(sqlitePath);
    evalSetId = seedTrustedSet(db, projectId, 12).evalSetId;
    keysRef = await storeCustomerKey(db, projectId);
    const split = ensureEvalSplit(db, evalSetId);
    const inputOf = (id: string) =>
      (db.prepare(`SELECT input_truncated FROM evals WHERE id = ?`).get(id) as { input_truncated: string })
        .input_truncated;
    holdoutInputs = new Set(
      [...split.splits].filter(([, s]) => s === "holdout").map(([id]) => inputOf(id)),
    );
    trainInputs = [...split.splits].filter(([, s]) => s === "train").map(([id]) => inputOf(id));
    db.close();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function post(name: string, payload: Record<string, unknown>) {
    const res = await app.inject({ method: "POST", url: `/v1/tools/${name}`, headers: authHeaders(), payload });
    return { status: res.statusCode, body: res.json() as Record<string, unknown>, text: res.body };
  }

  it("stores outputs, hides holdout, and reverts a change that breaks holdout", async () => {
    const started = await post("run_evals", {
      project_id: projectId,
      eval_set_id: evalSetId,
      candidates: [
        { id: "m/a#v1", model: "m/a", system_prompt: "v1" },
        { id: "m/a#v2", model: "m/a", system_prompt: "v2" },
      ],
      reps: 2,
      max_eval_spend_usd: 5,
      keys_ref: keysRef,
      idempotency_key: "e2e-run",
    });
    assert.equal(started.status, 200, started.text);
    const runId = started.body.run_id as string;
    const report = await waitForRunComplete(app, projectId, runId);
    assert.equal(report.status, "succeeded");
    assert.equal(JSON.stringify(report).includes("BAD input-"), false, "report has output blobs");

    const failures = await post("get_training_failures", {
      project_id: projectId,
      run_id: runId,
      candidate_id: "m/a#v1",
    });
    assert.equal(failures.status, 200, failures.text);
    const body = getTrainingFailuresOutputSchema.parse(failures.body);
    assert.equal(body.failures.length, 3);
    assert.match(body.failures[0]!.reps[0]!.output ?? "", /^BAD input-/);
    assert.equal(body.holdout.n_fail, 0);

    const v2Failures = await post("get_training_failures", {
      project_id: projectId,
      run_id: runId,
      candidate_id: "m/a#v2",
    });
    const v2Body = getTrainingFailuresOutputSchema.parse(v2Failures.body);
    assert.equal(v2Body.failures.length, 0);
    assert.equal(v2Body.holdout.n_fail, holdoutInputs.size);
    for (const input of holdoutInputs) {
      assert.equal(v2Failures.text.includes(input), false);
    }

    const verdict = await post("get_verdict", {
      project_id: projectId,
      baseline_run_id: runId,
      baseline_candidate_id: "m/a#v1",
      candidate_run_id: runId,
      candidate_id: "m/a#v2",
    });
    assert.equal(verdict.status, 200, verdict.text);
    assert.equal(verdict.body.verdict, "revert_regressed");
    for (const input of holdoutInputs) {
      assert.equal(verdict.text.includes(input), false);
    }
  });
});
