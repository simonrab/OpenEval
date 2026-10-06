import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { insertDraftEvals } from "../src/eval-set.js";
import { buildApp } from "../src/server.js";
import { ensureEvalSplit } from "../src/splits.js";
import {
  getEvalInputsOutputSchema,
  parseToolInput,
  submitOutputsOutputSchema,
} from "../src/tools/schema.js";
import { ErrorCode } from "../src/tools/types.js";
import { caseDraft, seedTrustedSet } from "./helpers/optimizer-fixtures.js";
import {
  authHeaders,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

type Body = Record<string, unknown>;

describe("harness outputs: get_eval_inputs and submit_outputs", () => {
  let dir: string;
  let app: FastifyInstance;
  let db: Database.Database;
  let projectId: string;
  let evalSetId: string;
  let evalIds: string[];
  let train: string[];
  let holdout: string[];
  let inputOf: Map<string, string>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openeval-harness-"));
    const sqlitePath = join(dir, "openeval.sqlite");
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      baseUrl: "http://test.local",
      openRouterClient: {
        async chatCompletion(input) {
          return { content: `fine ${input.prompt}`, time_ms: 10, cost_usd: 0.002, cost_source: "provider" };
        },
      },
    });
    const proj = await app.inject({ method: "POST", url: "/v1/projects", headers: authHeaders(), payload: {} });
    projectId = (proj.json() as { project_id: string }).project_id;
    db = openDb(sqlitePath);
    const seeded = seedTrustedSet(db, projectId, 12);
    evalSetId = seeded.evalSetId;
    evalIds = seeded.evalIds;
    const split = ensureEvalSplit(db, evalSetId);
    train = [...split.splits].filter(([, s]) => s === "train").map(([id]) => id);
    holdout = [...split.splits].filter(([, s]) => s === "holdout").map(([id]) => id);
    inputOf = new Map(
      evalIds.map((id) => [
        id,
        (db.prepare(`SELECT input_truncated FROM evals WHERE id = ?`).get(id) as { input_truncated: string })
          .input_truncated,
      ]),
    );
  });

  afterEach(async () => {
    db.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function post(name: string, payload: Body): Promise<{ status: number; body: Body; text: string }> {
    const res = await app.inject({ method: "POST", url: `/v1/tools/${name}`, headers: authHeaders(), payload });
    return { status: res.statusCode, body: res.json() as Body, text: res.body };
  }

  /** One output per eval. bad ids get an output that fails the check. */
  function outputs(bad: Set<string> = new Set(), ids: string[] = evalIds) {
    return ids.map((id) => ({
      eval_id: id,
      output: bad.has(id) ? `BAD ${inputOf.get(id)}` : `fine ${inputOf.get(id)}`,
      time_ms: 50,
      cost_usd: 0.001,
    }));
  }

  async function submit(candidateId: string, outs: unknown[], key = `idem-${candidateId}`) {
    return post("submit_outputs", {
      project_id: projectId,
      eval_set_id: evalSetId,
      candidate: { id: candidateId, description: "harness change", commit: "abc123" },
      outputs: outs,
      idempotency_key: key,
    });
  }

  it("get_eval_inputs returns trusted inputs only, with no checks, splits, or results", async () => {
    db.prepare(`UPDATE jobs SET limits = ? WHERE project_id = ?`).run(
      JSON.stringify({ system_prompt: "Be short." }),
      projectId,
    );
    const draft = insertDraftEvals(db, evalSetId, [caseDraft(99)]);
    const first = await post("get_eval_inputs", { project_id: projectId, eval_set_id: evalSetId, limit: 5 });
    assert.equal(first.status, 200, first.text);
    const parsed = getEvalInputsOutputSchema.parse(first.body);
    assert.equal(parsed.system_prompt, "Be short.");
    assert.equal(parsed.n_evals, 12);
    assert.equal(parsed.inputs.length, 5);
    assert.equal(parsed.next_action.tool, "get_eval_inputs");
    for (const banned of ["program_check", "must_not_contain", "BAD", "holdout", "train", "title-", "passed"]) {
      assert.equal(first.text.includes(banned), false, `leaks ${banned}`);
    }

    const seen = [...parsed.inputs];
    let cursor = parsed.next_cursor;
    while (cursor) {
      const page = await post("get_eval_inputs", { project_id: projectId, eval_set_id: evalSetId, limit: 5, cursor });
      const p = getEvalInputsOutputSchema.parse(page.body);
      seen.push(...p.inputs);
      cursor = p.next_cursor;
      if (!cursor) {
        assert.equal(p.next_action.tool, "submit_outputs");
      }
    }
    assert.deepEqual(seen.map((s) => s.eval_id).sort(), [...evalIds].sort());
    for (const s of seen) {
      assert.equal(s.input, inputOf.get(s.eval_id));
    }
    assert.ok(holdout.every((id) => seen.some((s) => s.eval_id === id)));
    assert.equal(seen.some((s) => s.eval_id === draft[0]!.eval_id), false);
  });

  it("get_eval_inputs rejects an eval set of another project", async () => {
    const other = await app.inject({ method: "POST", url: "/v1/projects", headers: authHeaders(), payload: {} });
    const otherId = (other.json() as { project_id: string }).project_id;
    const res = await post("get_eval_inputs", { project_id: otherId, eval_set_id: evalSetId });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, ErrorCode.SUITE_NOT_FOUND);
  });

  it("submit_outputs scores outputs, stores a done run, and returns counts only", async () => {
    const res = await submit("harness#v1", outputs(new Set([train[0]!, holdout[0]!])));
    assert.equal(res.status, 200, res.text);
    const out = submitOutputsOutputSchema.parse(res.body);
    assert.equal(out.candidate_id, "harness#v1");
    assert.equal(out.n_scored, 12);
    assert.equal(out.n_error, 0);
    assert.equal(out.n_not_scored, 0);
    assert.equal(out.next_action.tool, "get_verdict");
    assert.equal(out.next_action.args.candidate_run_id, out.run_id);
    assert.equal(out.next_action.args.candidate_id, "harness#v1");
    assert.equal(res.text.includes(holdout[0]!), false, "submit result names an eval");
    assert.equal(/pass|fail/i.test(res.text.replace(/"get_verdict"/g, "")), false);

    const run = db.prepare(`SELECT status, intent, keys_ref, candidates FROM runs WHERE id = ?`).get(out.run_id) as {
      status: string;
      intent: string;
      keys_ref: string | null;
      candidates: string;
    };
    assert.equal(run.status, "succeeded");
    assert.equal(run.intent, "optimize");
    assert.equal(run.keys_ref, null);
    const stored = JSON.parse(run.candidates) as Array<Record<string, unknown>>;
    assert.equal(stored[0]!.id, "harness#v1");
    assert.equal(stored[0]!.commit, "abc123");

    const rows = db
      .prepare(`SELECT eval_id, passed, outcome, cost_source, cost_usd, time_ms FROM run_results WHERE run_id = ?`)
      .all(out.run_id) as Array<{ eval_id: string; passed: number; outcome: string; cost_source: string; cost_usd: number; time_ms: number }>;
    assert.equal(rows.length, 12);
    assert.ok(rows.every((r) => r.cost_source === "caller" && r.cost_usd === 0.001 && r.time_ms === 50));
    assert.equal(rows.find((r) => r.eval_id === train[0])!.passed, 0);
    assert.equal(rows.find((r) => r.eval_id === train[1])!.passed, 1);

    // The worker never claims the run.
    await new Promise((r) => setTimeout(r, 50));
    const after = db.prepare(`SELECT status FROM runs WHERE id = ?`).get(out.run_id) as { status: string };
    assert.equal(after.status, "succeeded");

    const report = await post("get_eval_report", { project_id: projectId, run_id: out.run_id });
    assert.equal(report.status, 200, report.text);
    const models = report.body.models as Array<{ model_id: string; cost_source: string }>;
    assert.equal(models[0]!.model_id, "harness#v1");
    assert.equal(models[0]!.cost_source, "caller");
  });

  it("submit_outputs replays the same run for the same idempotency_key", async () => {
    const a = await submit("harness#v1", outputs(), "idem-same");
    const b = await submit("harness#v1", outputs(), "idem-same");
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, b.body);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE intent = 'optimize'`).get() as { n: number };
    assert.equal(n.n, 1);
  });

  it("submit_outputs stores error rows, truncates long outputs, and counts missing evals", async () => {
    const outs = outputs(new Set(), evalIds.slice(0, 10));
    outs[0] = { eval_id: evalIds[0]!, error: "tool timeout", time_ms: 0 } as never;
    outs[1] = { eval_id: evalIds[1]!, output: `fine ${"x".repeat(9000)}` } as never;
    const res = await submit("harness#v2", outs);
    assert.equal(res.status, 200, res.text);
    const out = submitOutputsOutputSchema.parse(res.body);
    assert.equal(out.n_scored, 9);
    assert.equal(out.n_error, 1);
    assert.equal(out.n_not_scored, 2);
    const err = db
      .prepare(`SELECT outcome, passed, reason_short, cost_usd, cost_source FROM run_results WHERE run_id = ? AND eval_id = ?`)
      .get(out.run_id, evalIds[0]) as { outcome: string; passed: number; reason_short: string; cost_usd: number; cost_source: string };
    assert.equal(err.outcome, "error");
    assert.equal(err.passed, 0);
    assert.match(err.reason_short, /tool timeout/);
    assert.equal(err.cost_usd, 0);
    assert.equal(err.cost_source, "caller");
    const long = db
      .prepare(`SELECT output_truncated, passed FROM run_results WHERE run_id = ? AND eval_id = ?`)
      .get(out.run_id, evalIds[1]) as { output_truncated: string; passed: number };
    assert.equal(long.output_truncated.length, 4000);
    assert.equal(long.passed, 1);
  });

  it("submit_outputs rejects unknown, untrusted, and repeated eval ids", async () => {
    const unknown = await submit("harness#v1", [{ eval_id: "evl_nope", output: "x" }], "k1");
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, ErrorCode.INVALID_INPUT);
    assert.match(String(unknown.body.message), /evl_nope/);
    assert.equal((unknown.body.next_action as Body).tool, "get_eval_inputs");

    const draft = insertDraftEvals(db, evalSetId, [caseDraft(77)]);
    const untrusted = await submit("harness#v1", [{ eval_id: draft[0]!.eval_id, output: "x" }], "k2");
    assert.equal(untrusted.status, 400);

    const repeated = await submit(
      "harness#v1",
      [
        { eval_id: evalIds[0], output: "x" },
        { eval_id: evalIds[0], output: "y" },
      ],
      "k3",
    );
    assert.equal(repeated.status, 400);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number };
    assert.equal(n.n, 0);
  });

  it("validates the submit_outputs input shape", () => {
    const base = {
      project_id: "prj_1",
      eval_set_id: "ste_1",
      candidate: { id: "harness#v1" },
      outputs: [{ eval_id: "evl_1", output: "ok" }],
      idempotency_key: "k",
    };
    assert.equal(parseToolInput("submit_outputs", base).ok, true);
    const { idempotency_key: _k, ...noKey } = base;
    const missingKey = parseToolInput("submit_outputs", noKey);
    assert.equal(missingKey.ok, false);
    assert.equal(!missingKey.ok && missingKey.error.code, ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
    for (const id of ["", "has space", "a#b#c", "x#", "a#b c"]) {
      assert.equal(parseToolInput("submit_outputs", { ...base, candidate: { id } }).ok, false, id);
    }
    assert.equal(
      parseToolInput("submit_outputs", { ...base, outputs: [{ eval_id: "evl_1" }] }).ok,
      false,
      "output or error is required",
    );
    assert.equal(
      parseToolInput("submit_outputs", { ...base, outputs: [{ eval_id: "evl_1", output: "a", error: "b" }] }).ok,
      false,
      "not both output and error",
    );
    assert.equal(parseToolInput("submit_outputs", { ...base, outputs: [] }).ok, false);
  });

  describe("verdicts on harness runs", () => {
    function verdictArgs(baseRun: string, baseId: string, candRun: string, candId: string) {
      return {
        project_id: projectId,
        baseline_run_id: baseRun,
        baseline_candidate_id: baseId,
        candidate_run_id: candRun,
        candidate_id: candId,
      };
    }

    it("keeps a harness change that fixes train and holdout evals", async () => {
      const broken = new Set([...train.slice(0, 5), ...holdout]);
      const base = submitOutputsOutputSchema.parse((await submit("harness#base", outputs(broken))).body);
      const cand = submitOutputsOutputSchema.parse((await submit("harness#fix", outputs())).body);
      const verdict = await post("get_verdict", verdictArgs(base.run_id, "harness#base", cand.run_id, "harness#fix"));
      assert.equal(verdict.status, 200, verdict.text);
      assert.equal(verdict.body.verdict, "keep");

      const failures = await post("get_training_failures", {
        project_id: projectId,
        run_id: base.run_id,
        candidate_id: "harness#base",
      });
      assert.equal(failures.status, 200, failures.text);
      const ids = (failures.body.failures as Array<{ eval_id: string }>).map((f) => f.eval_id);
      assert.ok(ids.every((id) => train.includes(id)));
      assert.equal(holdout.some((id) => failures.text.includes(id)), false);
    });

    it("reverts a harness change that fixes train but breaks holdout", async () => {
      const base = submitOutputsOutputSchema.parse(
        (await submit("harness#base", outputs(new Set(train.slice(0, 3))))).body,
      );
      const cand = submitOutputsOutputSchema.parse((await submit("harness#over", outputs(new Set(holdout)))).body);
      const verdict = await post("get_verdict", verdictArgs(base.run_id, "harness#base", cand.run_id, "harness#over"));
      assert.equal(verdict.status, 200, verdict.text);
      assert.match(String(verdict.body.verdict), /^revert_/);
    });

    it("returns not_comparable when the harness skipped evals", async () => {
      const base = submitOutputsOutputSchema.parse((await submit("harness#base", outputs())).body);
      const cand = submitOutputsOutputSchema.parse(
        (await submit("harness#part", outputs(new Set(), evalIds.slice(0, 6)))).body,
      );
      const verdict = await post("get_verdict", verdictArgs(base.run_id, "harness#base", cand.run_id, "harness#part"));
      assert.equal(verdict.body.verdict, "not_comparable");
    });

    it("compares a run_evals baseline with a submit_outputs candidate", async () => {
      const keysRef = await storeCustomerKey(db, projectId);
      const started = await post("run_evals", {
        project_id: projectId,
        eval_set_id: evalSetId,
        candidates: [{ id: "m/a", model: "m/a" }],
        reps: 1,
        max_eval_spend_usd: 5,
        keys_ref: keysRef,
        idempotency_key: "idem-run",
      });
      assert.equal(started.status, 200, started.text);
      const runId = started.body.run_id as string;
      const report = await waitForRunComplete(app, projectId, runId);
      assert.equal(report.status, "succeeded");

      const cand = submitOutputsOutputSchema.parse((await submit("harness#v1", outputs())).body);
      const verdict = await post("get_verdict", verdictArgs(runId, "m/a", cand.run_id, "harness#v1"));
      assert.equal(verdict.status, 200, verdict.text);
      assert.notEqual(verdict.body.verdict, "not_comparable");
      assert.equal(verdict.body.n_shared_evals, 12);
    });
  });

  it("recommend_models does not name a model from a harness run", async () => {
    const out = submitOutputsOutputSchema.parse((await submit("harness#v1", outputs())).body);
    const res = await post("recommend_models", {
      project_id: projectId,
      eval_set_id: evalSetId,
      run_id: out.run_id,
      intent: "new_feature",
      idempotency_key: "idem-rec",
    });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.code, ErrorCode.INVALID_INPUT);
  });
});
