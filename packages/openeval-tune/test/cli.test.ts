import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { loadState, newState, saveState } from "../src/state.js";
import { verdictExitCode } from "../src/verdict.js";
import {
  fakeOpenEval,
  FIXTURE,
  FULL_KEY,
  OPT_KEY,
  reportBody,
  runCli,
  tempDir,
  verdictBody,
  type Handler,
} from "./helpers.js";

const node = JSON.stringify(process.execPath);
const cmd = (mode: string) => `${node} ${JSON.stringify(FIXTURE)} ${mode}`;
const INPUTS = Array.from({ length: 5 }, (_, i) => ({ eval_id: `ev_${i}`, input: `input-0${i}-x` }));

function baseHandlers(opts: { runCost?: number; verdicts?: unknown[] } = {}) {
  let runN = 0;
  const verdicts = [...(opts.verdicts ?? [])];
  const submitted: Array<Record<string, unknown>> = [];
  const handlers: Record<string, Handler> = {
    get_eval_inputs: (body) => {
      const offset = body.cursor ? Number(body.cursor) : 0;
      const page = INPUTS.slice(offset, offset + 2);
      const next = offset + page.length < INPUTS.length ? String(offset + page.length) : null;
      return {
        body: {
          eval_set_id: "ste_1",
          eval_set_version: 1,
          system_prompt: null,
          n_evals: INPUTS.length,
          inputs: page,
          next_cursor: next,
          truncated: next !== null,
        },
      };
    },
    submit_outputs: (body) => {
      submitted.push(body);
      runN += 1;
      const cand = body.candidate as { id: string };
      return {
        body: {
          run_id: `run_${runN}`,
          candidate_id: cand.id,
          eval_set_id: "ste_1",
          n_scored: 10,
          n_error: 0,
          n_not_scored: 0,
          n_person_evals_not_graded: 0,
          grader_advice: null,
        },
      };
    },
    run_evals: () => {
      runN += 1;
      return { body: { run_id: `run_${runN}`, status: "queued", eta_s: 1, est_cost_usd: 0.1 } };
    },
    get_eval_report: (body) => ({ body: reportBody(String(body.run_id), opts.runCost ?? 0.01) }),
    get_verdict: () => ({ body: verdicts.shift() ?? verdictBody("keep") }),
  };
  // The fake harness splits inputs over pages of 2, so baseline sees all 5.
  return { handlers, submitted };
}

describe("verdict exit codes", () => {
  it("maps every verdict and stop to its exit code", () => {
    assert.equal(verdictExitCode("keep", null), 0);
    assert.equal(verdictExitCode("revert_overfit", null), 2);
    assert.equal(verdictExitCode("revert_regressed", null), 2);
    assert.equal(verdictExitCode("within_noise", null), 3);
    assert.equal(verdictExitCode("not_comparable", null), 4);
    assert.equal(verdictExitCode("within_noise", "plateau"), 5);
    assert.equal(verdictExitCode("keep", "budget"), 6);
    assert.equal(verdictExitCode("revert_regressed", "max_rounds"), 6);
  });
});

describe("cli", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });

  it("baseline in harness mode runs every input and rep, submits, and saves the state", async () => {
    const { handlers, submitted } = baseHandlers();
    const fake = fakeOpenEval(handlers);
    const res = await runCli(
      ["baseline", "--mode", "harness", "--cmd", cmd("good"), "--reps", "2", "--budget", "5", "--commit", "abc123"],
      { fetch: fake.fetch, cwd: dir },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.run_id, "run_1");
    assert.equal(res.json.candidate_id, "harness#base");
    // Three pages of inputs, then one submit and one report.
    assert.deepEqual(
      fake.calls.map((c) => c.tool),
      ["get_eval_inputs", "get_eval_inputs", "get_eval_inputs", "submit_outputs", "get_eval_report"],
    );
    assert.ok(fake.calls.every((c) => c.auth === `Bearer ${OPT_KEY}`));
    const body = submitted[0]!;
    const outputs = body.outputs as Array<Record<string, unknown>>;
    assert.equal(outputs.length, 10);
    assert.deepEqual(body.candidate, { id: "harness#base", label: "base", commit: "abc123" });
    assert.equal(typeof body.idempotency_key, "string");
    assert.equal(body.keys_ref, "key_1");
    assert.ok((body.max_eval_spend_usd as number) > 0);
    assert.deepEqual(outputs[0], {
      eval_id: "ev_0",
      rep: 0,
      output: "fine answer",
      time_ms: outputs[0]!.time_ms,
      cost_usd: 0.001,
      prompt_tokens: 10,
      completion_tokens: 5,
      served_model: "fake/model",
    });
    const state = loadState(join(dir, ".openeval-tune"))!;
    assert.equal(state.mode, "harness");
    assert.equal(state.reps, 2);
    assert.equal(state.budget_usd, 5);
    assert.deepEqual(state.baseline, { run_id: "run_1", candidate_id: "harness#base" });
    assert.deepEqual(state.original_baseline, state.baseline);
    assert.equal(state.spend_usd, 0.01);
    assert.match(state.session_id, /^tune-/);
  });

  it("refuses a full key in the loop and never prints the key", async () => {
    const fake = fakeOpenEval({});
    const res = await runCli(["baseline", "--mode", "harness", "--cmd", cmd("good")], {
      fetch: fake.fetch,
      cwd: dir,
      env: { OPENEVAL_KEY: FULL_KEY },
    });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /not an optimizer key/);
    assert.ok(!res.stderr.includes(FULL_KEY));
    assert.equal(fake.calls.length, 0);
  });

  it("refuses a candidate with other reps or another mode", async () => {
    const { handlers } = baseHandlers();
    const fake = fakeOpenEval(handlers);
    await runCli(["baseline", "--mode", "harness", "--cmd", cmd("good"), "--reps", "2"], { fetch: fake.fetch, cwd: dir });
    const reps = await runCli(["run-harness", "--cmd", cmd("good"), "--label", "r1", "--reps", "3"], {
      fetch: fake.fetch,
      cwd: dir,
    });
    assert.equal(reps.code, 1);
    assert.match(reps.stderr, /baseline uses 2 reps/);
    const mode = await runCli(["run-direct", "--candidate", '{"model":"m/x"}'], { fetch: fake.fetch, cwd: dir });
    assert.equal(mode.code, 1);
    assert.match(mode.stderr, /harness mode/);
  });

  it("verdict keep sets the new baseline and exits 0; revert verdicts keep the baseline", async () => {
    const { handlers } = baseHandlers({
      verdicts: [verdictBody("keep"), verdictBody("revert_overfit"), verdictBody("within_noise"), verdictBody("not_comparable")],
    });
    const fake = fakeOpenEval(handlers);
    const opts = { fetch: fake.fetch, cwd: dir };
    await runCli(["baseline", "--mode", "harness", "--cmd", cmd("good"), "--reps", "1"], opts);

    await runCli(["run-harness", "--cmd", cmd("good"), "--label", "r1"], opts);
    const keep = await runCli(["verdict"], opts);
    assert.equal(keep.code, 0, keep.stderr);
    assert.equal(keep.json.action, "keep");
    const vcall = fake.calls.filter((c) => c.tool === "get_verdict")[0]!;
    assert.equal(vcall.body.baseline_run_id, "run_1");
    assert.equal(vcall.body.baseline_candidate_id, "harness#base");
    assert.equal(vcall.body.candidate_run_id, "run_2");
    assert.equal(vcall.body.candidate_id, "harness#r1");
    assert.equal(typeof vcall.body.session_id, "string");
    assert.equal(typeof vcall.body.idempotency_key, "string");
    let state = loadState(join(dir, ".openeval-tune"))!;
    assert.deepEqual(state.baseline, { run_id: "run_2", candidate_id: "harness#r1" });

    await runCli(["run-harness", "--cmd", cmd("good"), "--label", "r2"], opts);
    const overfit = await runCli(["verdict", "--min-effect", "0.05"], opts);
    assert.equal(overfit.code, 2);
    assert.equal(overfit.json.action, "revert");
    const v2 = fake.calls.filter((c) => c.tool === "get_verdict")[1]!;
    assert.equal(v2.body.baseline_run_id, "run_2");
    assert.equal(v2.body.min_effect, 0.05);

    await runCli(["run-harness", "--cmd", cmd("good"), "--label", "r3"], opts);
    const noise = await runCli(["verdict"], opts);
    assert.equal(noise.code, 3);

    await runCli(["run-harness", "--cmd", cmd("good"), "--label", "r4"], opts);
    const nc = await runCli(["verdict"], opts);
    assert.equal(nc.code, 4);
    assert.equal(nc.json.action, "fix_and_rescore");

    state = loadState(join(dir, ".openeval-tune"))!;
    assert.deepEqual(state.baseline, { run_id: "run_2", candidate_id: "harness#r1" });
    assert.deepEqual(
      state.rounds.map((r) => r.verdict),
      ["keep", "revert_overfit", "within_noise", "not_comparable"],
    );
    const status = await runCli(["status"], opts);
    assert.equal(status.json.rounds, 4);
    assert.equal(status.json.kept, 1);
    assert.equal(status.json.flat_rounds, 2);
  });

  it("verdict plateau exits 5", async () => {
    const { handlers } = baseHandlers({ verdicts: [verdictBody("within_noise", { plateau: true, flat_rounds: 3 })] });
    const fake = fakeOpenEval(handlers);
    const opts = { fetch: fake.fetch, cwd: dir };
    await runCli(["baseline", "--mode", "harness", "--cmd", cmd("good"), "--reps", "1"], opts);
    await runCli(["run-harness", "--cmd", cmd("good"), "--label", "r1"], opts);
    const res = await runCli(["verdict"], opts);
    assert.equal(res.code, 5);
    assert.equal(res.json.stop, "plateau");
  });

  it("stops at the budget: verdict exits 6 and new runs are refused", async () => {
    const { handlers } = baseHandlers({ runCost: 0.6 });
    const fake = fakeOpenEval(handlers);
    const opts = { fetch: fake.fetch, cwd: dir };
    const base = await runCli(["baseline", "--mode", "harness", "--cmd", cmd("good"), "--reps", "1", "--budget", "1"], opts);
    assert.equal(base.code, 0, base.stderr);
    await runCli(["run-harness", "--cmd", cmd("good"), "--label", "r1"], opts);
    const v = await runCli(["verdict"], opts);
    assert.equal(v.code, 6);
    assert.equal(v.json.verdict, "keep");
    assert.equal(v.json.stop, "budget");
    const before = fake.calls.length;
    const again = await runCli(["run-harness", "--cmd", cmd("good"), "--label", "r2"], opts);
    assert.equal(again.code, 6);
    assert.match(again.stderr, /budget is spent/);
    assert.equal(fake.calls.length, before, "no OpenEval call after the budget is spent");
  });

  it("stops at max rounds with exit 6", async () => {
    const { handlers } = baseHandlers({ verdicts: [verdictBody("revert_regressed")] });
    const fake = fakeOpenEval(handlers);
    const opts = { fetch: fake.fetch, cwd: dir };
    await runCli(["baseline", "--mode", "harness", "--cmd", cmd("good"), "--reps", "1", "--max-rounds", "1"], opts);
    await runCli(["run-harness", "--cmd", cmd("good"), "--label", "r1"], opts);
    const v = await runCli(["verdict"], opts);
    assert.equal(v.code, 6);
    assert.equal(v.json.stop, "max_rounds");
    assert.equal(v.json.action, "revert");
  });

  it("stops the harness at the budget and submits nothing", async () => {
    const { handlers, submitted } = baseHandlers();
    const fake = fakeOpenEval(handlers);
    const res = await runCli(
      ["baseline", "--mode", "harness", "--cmd", cmd("costly"), "--reps", "1", "--budget", "2", "--concurrency", "1"],
      { fetch: fake.fetch, cwd: dir },
    );
    assert.equal(res.code, 6);
    assert.equal(submitted.length, 0);
    const state = loadState(join(dir, ".openeval-tune"))!;
    assert.equal(state.spend_usd, 2);
  });

  it("run-direct sends the candidate with a system prompt file to run_evals and polls", async () => {
    const { handlers } = baseHandlers();
    const fake = fakeOpenEval(handlers);
    const opts = { fetch: fake.fetch, cwd: dir };
    writeFileSync(join(dir, "prompt.txt"), "Never say BAD.");
    writeFileSync(
      join(dir, "cand.json"),
      JSON.stringify({ model: "m/x", settings: { temperature: 0 }, system_prompt_file: "prompt.txt" }),
    );
    const base = await runCli(["baseline", "--mode", "direct", "--candidate", '{"model":"m/x","label":"base"}', "--reps", "2"], opts);
    assert.equal(base.code, 0, base.stderr);
    const res = await runCli(["run-direct", "--candidate", "cand.json", "--label", "p1", "--max-spend", "1.5"], opts);
    assert.equal(res.code, 0, res.stderr);
    const runs = fake.calls.filter((c) => c.tool === "run_evals");
    assert.deepEqual(runs[0]!.body.candidates, [{ id: "m/x#base", model: "m/x" }]);
    assert.deepEqual(runs[1]!.body.candidates, [
      { id: "m/x#p1", model: "m/x", settings: { temperature: 0 }, system_prompt: "Never say BAD." },
    ]);
    assert.equal(runs[1]!.body.reps, 2);
    assert.equal(runs[1]!.body.max_eval_spend_usd, 1.5);
    assert.equal(runs[1]!.body.keys_ref, "key_1");
    const state = loadState(join(dir, ".openeval-tune"))!;
    assert.equal(state.runs[1]!.setup!.system_prompt, "Never say BAD.");
  });

  it("failures reads training failures of the baseline page by page", async () => {
    const { handlers } = baseHandlers();
    const failures = Array.from({ length: 3 }, (_, i) => ({
      eval_id: `ev_${i}`,
      title: `t${i}`,
      input: `in ${i}`,
      archetype_id: null,
      scorer_primitive: "must_not_contain",
      flaky: false,
      reps: [{ rep: 0, passed: false, reason_short: "has BAD", output: "BAD" }],
    }));
    handlers.get_training_failures = (body) => {
      const offset = body.cursor ? Number(body.cursor) : 0;
      const page = failures.slice(offset, offset + 2);
      const next = offset + page.length < failures.length ? String(offset + page.length) : null;
      return {
        body: {
          run_id: body.run_id,
          candidate_id: body.candidate_id,
          eval_set_id: "ste_1",
          directional: false,
          train: { n_evals: 7, n_pass: 4, n_fail: 3, n_flaky: 0, n_error: 0 },
          holdout: { n_evals: 3, n_pass: 1, n_fail: 2, n_error: 0 },
          failures: page,
          next_cursor: next,
          truncated: next !== null,
        },
      };
    };
    const fake = fakeOpenEval(handlers);
    const opts = { fetch: fake.fetch, cwd: dir };
    await runCli(["baseline", "--mode", "harness", "--cmd", cmd("good"), "--reps", "1"], opts);
    const res = await runCli(["failures"], opts);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.failures.length, 3);
    assert.equal(res.json.failures[0].reps[0].output, "BAD");
    assert.equal(res.json.more, false);
    const calls = fake.calls.filter((c) => c.tool === "get_training_failures");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.body.run_id, "run_1");
    assert.equal(calls[0]!.body.candidate_id, "harness#base");
  });

  it("promote refuses the optimizer key and a missing admin key", async () => {
    const state = newState({ project_id: "prj_1", eval_set_id: "ste_1", mode: "direct" });
    saveState(join(dir, ".openeval-tune"), state);
    const fake = fakeOpenEval({});
    const missing = await runCli(["promote", "--run", "run_1", "--candidate", "m/x#p1"], { fetch: fake.fetch, cwd: dir });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /needs OPENEVAL_ADMIN_KEY/);
    const opt = await runCli(["promote", "--run", "run_1", "--candidate", "m/x#p1"], {
      fetch: fake.fetch,
      cwd: dir,
      env: { OPENEVAL_ADMIN_KEY: "oeo_other_optimizer" },
    });
    assert.equal(opt.code, 1);
    assert.match(opt.stderr, /optimizer key/);
    assert.ok(!opt.stderr.includes("oeo_other_optimizer"));
    const same = await runCli(["promote", "--run", "run_1", "--candidate", "m/x#p1"], {
      fetch: fake.fetch,
      cwd: dir,
      env: { OPENEVAL_ADMIN_KEY: OPT_KEY },
    });
    assert.equal(same.code, 1);
    assert.equal(fake.calls.length, 0);
  });

  it("promote refuses a harness candidate", async () => {
    const state = newState({ project_id: "prj_1", eval_set_id: "ste_1", mode: "harness" });
    saveState(join(dir, ".openeval-tune"), state);
    const fake = fakeOpenEval({});
    const res = await runCli(["promote", "--run", "run_1", "--candidate", "harness#r1"], {
      fetch: fake.fetch,
      cwd: dir,
      env: { OPENEVAL_ADMIN_KEY: FULL_KEY },
    });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /harness candidate/);
    assert.equal(fake.calls.length, 0);
  });

  it("promote stops at each human gate and continues only after approval", async () => {
    const state = newState({ project_id: "prj_1", eval_set_id: "ste_1", mode: "direct" });
    state.runs.push({
      run_id: "run_9",
      candidate_id: "m/x#p1",
      mode: "direct",
      label: "p1",
      reps: 3,
      cost_usd: 0,
      created_at: "",
      setup: { id: "m/x#p1", model: "m/x", system_prompt: "Never say BAD." },
    });
    saveState(join(dir, ".openeval-tune"), state);
    let recApproved = false;
    let policyApproved = false;
    let canaryOn = false;
    let fullOn = false;
    const fake = fakeOpenEval({
      run_evals: () => ({ body: { run_id: "run_confirm", status: "queued", eta_s: 1, est_cost_usd: 0 } }),
      get_eval_report: (b) => ({ body: reportBody(String(b.run_id), 0.2) }),
      recommend_models: () => ({
        body: { recommendation_id: "rec_1", approve_url: "http://oe.test/approve?rec=1", named_model: { id: "m/x#p1" } },
      }),
      compile_policy: () =>
        recApproved
          ? {
              body: {
                policy_id: "pol_2",
                approve_url: "http://oe.test/compile-approve?p=2",
                primary: { has_system_prompt: true, candidate_id: "m/x#p1" },
                system_prompt_note: "note",
              },
            }
          : { status: 400, body: { code: "REC_NOT_APPROVED", message: "No person approved this recommendation." } },
      get_live_report: () => ({
        body: {
          policy_id: fullOn ? "pol_2" : "pol_1",
          candidate_id: null,
          canary: canaryOn,
          canary_candidate_id: canaryOn ? "m/x#p1" : null,
          observed_split: 5,
          fallback_rate: 0,
          sample_counts: { stored: 0, dropped: 0, pii_blocked: 0 },
        },
      }),
      propose_rollout: (b) =>
        b.intent === "canary" && !policyApproved
          ? { status: 400, body: { code: "POLICY_NOT_APPROVED", message: "A draft policy exists. It is not live." } }
          : { body: { rollout_id: `ro_${String(b.intent)}`, approve_url: `http://oe.test/rollout?i=${String(b.intent)}` } },
    });
    const opts = { fetch: fake.fetch, cwd: dir, env: { OPENEVAL_ADMIN_KEY: FULL_KEY } };

    const start = await runCli(["promote", "--run", "run_9", "--candidate", "m/x#p1"], opts);
    assert.equal(start.code, 7, start.stderr);
    assert.equal(start.json.stage, "await_recommendation_approval");
    assert.equal(start.json.approve_url, "http://oe.test/approve?rec=1");
    assert.ok(fake.calls.every((c) => c.auth === `Bearer ${FULL_KEY}`));
    const run = fake.calls.find((c) => c.tool === "run_evals")!;
    assert.deepEqual(run.body.candidates, [{ id: "m/x#p1", model: "m/x", system_prompt: "Never say BAD." }]);

    const wait1 = await runCli(["promote", "--continue"], opts);
    assert.equal(wait1.code, 7);
    assert.equal(wait1.json.stage, "await_recommendation_approval");

    recApproved = true;
    const gate2 = await runCli(["promote", "--continue"], opts);
    assert.equal(gate2.code, 7);
    assert.equal(gate2.json.stage, "await_policy_approval");
    assert.match(gate2.json.note, /applyPolicySystemPrompt: true/);

    const wait2 = await runCli(["promote", "--continue"], opts);
    assert.equal(wait2.json.stage, "await_policy_approval");

    policyApproved = true;
    const gate3 = await runCli(["promote", "--continue"], opts);
    assert.equal(gate3.json.stage, "await_canary_approval");
    assert.equal(gate3.json.approve_url, "http://oe.test/rollout?i=canary");

    canaryOn = true;
    const live = await runCli(["promote", "--continue"], opts);
    assert.equal(live.json.stage, "canary_live");
    assert.equal(live.code, 7);

    const gate4 = await runCli(["promote", "--continue", "--full"], opts);
    assert.equal(gate4.json.stage, "await_full_approval");

    canaryOn = false;
    fullOn = true;
    const done = await runCli(["promote", "--continue"], opts);
    assert.equal(done.code, 0);
    assert.equal(done.json.stage, "done");
    // The CLI never calls an approval route itself.
    assert.ok(fake.calls.every((c) => c.path.startsWith("/v1/tools/")));
    const saved = JSON.parse(readFileSync(join(dir, ".openeval-tune", "state.json"), "utf8"));
    assert.equal(saved.promote.stage, "done");
  });

  it("prints help and rejects an unknown flag", async () => {
    const help = await runCli(["help"], { cwd: dir });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Exit codes/);
    const bad = await runCli(["status", "--nope"], { cwd: dir });
    assert.equal(bad.code, 1);
  });
});
