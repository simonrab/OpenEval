import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
// The real OpenEval app and its test seed helpers, from the repo root.
import { openDb } from "../../../src/db.js";
import { buildApp } from "../../../src/server.js";
import { seedTrustedSet } from "../../../test/helpers/optimizer-fixtures.js";
import { loadState } from "../src/state.js";
import { FIXTURE, runCli, tempDir } from "./helpers.js";

const FULL = "e2e-full-key-not-a-secret";
const node = JSON.stringify(process.execPath);
const cmd = (mode: string) => `${node} ${JSON.stringify(FIXTURE)} ${mode}`;

describe("end to end with the real OpenEval app", () => {
  let dir: string;
  let app: FastifyInstance;
  let db: Database.Database;
  let url: string;
  let projectId: string;
  let evalSetId: string;
  let keysRef: string;
  let optKey: string;

  async function admin(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${FULL}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as Record<string, unknown>;
  }

  before(async () => {
    dir = tempDir("openeval-tune-e2e-");
    const sqlitePath = join(dir, "openeval.sqlite");
    app = await buildApp({
      sqlitePath,
      apiKey: FULL,
      baseUrl: "http://test.local",
      openRouterClient: {
        // The model fails the must_not_contain check unless the system prompt fixes it.
        async chatCompletion(input) {
          const fixed = (input.systemPrompt ?? "").includes("Never say BAD");
          return {
            content: fixed ? `fine ${input.prompt}` : `BAD ${input.prompt}`,
            time_ms: 10,
            cost_usd: 0.002,
            cost_source: "provider",
          };
        },
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    assert.ok(addr && typeof addr === "object");
    url = `http://127.0.0.1:${addr.port}`;

    projectId = String((await admin("/v1/projects", {})).project_id);
    db = openDb(sqlitePath);
    evalSetId = seedTrustedSet(db, projectId, 12).evalSetId;
    keysRef = String((await admin("/v1/keys", { project_id: projectId, secret: "sk-or-test" })).keys_ref);
    const minted = await admin("/v1/keys", { project_id: projectId, scope: "optimizer" });
    optKey = String(minted.api_key);
    assert.match(optKey, /^oeo_/);
  });

  after(async () => {
    db.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function env(): Record<string, string> {
    return {
      OPENEVAL_URL: url,
      OPENEVAL_KEY: optKey,
      OPENEVAL_PROJECT_ID: projectId,
      OPENEVAL_EVAL_SET_ID: evalSetId,
      OPENEVAL_KEYS_REF: keysRef,
      OPENEVAL_TUNE_POLL_MS: "25",
    };
  }

  it("harness mode: baseline, better candidate, verdict keep", async () => {
    const work = tempDir("openeval-tune-harness-");
    const opts = { cwd: work, env: env() };

    const base = await runCli(["baseline", "--mode", "harness", "--cmd", cmd("bad"), "--reps", "2", "--budget", "5"], opts);
    assert.equal(base.code, 0, base.stderr);
    assert.equal(base.json.candidate_id, "harness#base");
    assert.ok(base.json.cost_usd >= 0.024 - 1e-9, "the caller cost of 24 calls is in the run spend");

    const fails = await runCli(["failures"], opts);
    assert.equal(fails.code, 0, fails.stderr);
    assert.ok(fails.json.failures.length > 0);
    assert.ok(fails.json.train.n_fail > 0);
    // The player sees holdout counts only, never holdout inputs.
    const holdoutN = fails.json.holdout_counts.n_evals;
    assert.ok(holdoutN > 0);
    assert.equal(fails.json.train.n_evals + holdoutN, 12);

    const cand = await runCli(["run-harness", "--cmd", cmd("good"), "--label", "r1", "--commit", "abc1234"], opts);
    assert.equal(cand.code, 0, cand.stderr);

    const v = await runCli(["verdict"], opts);
    assert.equal(v.code, 0, v.stderr);
    assert.equal(v.json.verdict, "keep");
    assert.equal(v.json.action, "keep");
    assert.equal(v.json.rounds, 1);
    assert.ok(v.json.holdout.delta > 0);

    const state = loadState(join(work, ".openeval-tune"))!;
    assert.deepEqual(state.baseline, { run_id: cand.json.run_id, candidate_id: "harness#r1" });

    // A worse candidate is reverted against the new baseline.
    await runCli(["run-harness", "--cmd", cmd("bad"), "--label", "r2"], opts);
    const worse = await runCli(["verdict"], opts);
    assert.equal(worse.code, 2, worse.stderr);
    assert.equal(worse.json.verdict, "revert_regressed");

    const report = await runCli(["report"], opts);
    assert.equal(report.code, 0, report.stderr);
    assert.equal(report.json.kept.length, 1);
    assert.equal(report.json.kept[0].commit, "abc1234");
    assert.equal(report.json.vs_original.verdict_vs_original, "keep");

    // promote refuses the optimizer key before any call.
    const promote = await runCli(["promote", "--run", cand.json.run_id, "--candidate", "harness#r1"], {
      ...opts,
      env: { ...env(), OPENEVAL_ADMIN_KEY: optKey },
    });
    assert.equal(promote.code, 1);
    assert.ok(!promote.stderr.includes(optKey));
    rmSync(work, { recursive: true, force: true });
  });

  it("direct mode: baseline, system prompt candidate, verdict keep", async () => {
    const work = tempDir("openeval-tune-direct-");
    const opts = { cwd: work, env: env() };
    const model = "openai/gpt-4.1-nano";

    const base = await runCli(
      ["baseline", "--mode", "direct", "--candidate", JSON.stringify({ model, label: "base" }), "--reps", "1"],
      opts,
    );
    assert.equal(base.code, 0, base.stderr);
    assert.equal(base.json.candidate_id, `${model}#base`);

    const cand = await runCli(
      ["run-direct", "--candidate", JSON.stringify({ model, system_prompt: "Never say BAD." }), "--label", "p1"],
      opts,
    );
    assert.equal(cand.code, 0, cand.stderr);
    assert.equal(cand.json.candidate_id, `${model}#p1`);

    const v = await runCli(["verdict"], opts);
    assert.equal(v.code, 0, v.stderr);
    assert.equal(v.json.verdict, "keep");
    assert.equal(v.json.holdout.candidate_pass_rate, 1);
    assert.equal(v.json.holdout.baseline_pass_rate, 0);

    const status = await runCli(["status"], opts);
    assert.equal(status.json.mode, "direct");
    assert.ok(status.json.spend_usd > 0);
    rmSync(work, { recursive: true, force: true });
  });

  /** The test plays the person: it posts the approval form of the URL. */
  async function personApproves(approveUrl: string): Promise<void> {
    const u = new URL(approveUrl);
    const res = await fetch(`${url}${u.pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ...Object.fromEntries(u.searchParams), decision: "approved" }),
    });
    assert.equal(res.status, 200, await res.text());
  }

  it("promote: stops at every human gate, then ships with canary and full", async () => {
    const work = tempDir("openeval-tune-promote-");
    const model = "openai/gpt-4.1-nano";
    const opts = { cwd: work, env: { ...env(), OPENEVAL_ADMIN_KEY: FULL } };

    await runCli(["baseline", "--mode", "direct", "--candidate", JSON.stringify({ model, label: "base" }), "--reps", "1"], opts);
    const p1 = await runCli(
      ["run-direct", "--candidate", JSON.stringify({ model, system_prompt: "Never say BAD." }), "--label", "p1"],
      opts,
    );
    assert.equal(p1.code, 0, p1.stderr);

    // The baseline fails trusted evals, so OpenEval names nothing.
    const refused = await runCli(["promote", "--run", (loadState(join(work, ".openeval-tune"))!.original_baseline!).run_id, "--candidate", `${model}#base`], opts);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /did not name this setup/);

    // First policy of the project: two gates, then it is the last full policy.
    const g1 = await runCli(["promote", "--run", p1.json.run_id, "--candidate", p1.json.candidate_id], opts);
    assert.equal(g1.code, 7, g1.stderr);
    assert.equal(g1.json.stage, "await_recommendation_approval");
    const notYet = await runCli(["promote", "--continue"], opts);
    assert.equal(notYet.code, 7);
    assert.equal(notYet.json.stage, "await_recommendation_approval");
    await personApproves(g1.json.approve_url);
    const g2 = await runCli(["promote", "--continue"], opts);
    assert.equal(g2.json.stage, "await_policy_approval", g2.stderr);
    assert.match(g2.json.note, /applyPolicySystemPrompt: true/);
    await personApproves(g2.json.approve_url);
    const first = await runCli(["promote", "--continue"], opts);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.stage, "done");

    // A second setup goes through the 5% canary and the full rollout.
    const p2 = await runCli(
      ["run-direct", "--candidate", JSON.stringify({ model, system_prompt: "Never say BAD. Be short.", settings: { temperature: 0 } }), "--label", "p2"],
      opts,
    );
    assert.equal(p2.code, 0, p2.stderr);
    const s1 = await runCli(["promote", "--run", p2.json.run_id, "--candidate", p2.json.candidate_id, "--reuse-run"], opts);
    assert.equal(s1.json.stage, "await_recommendation_approval", s1.stderr);
    await personApproves(s1.json.approve_url);
    const s2 = await runCli(["promote", "--continue"], opts);
    assert.equal(s2.json.stage, "await_policy_approval");
    const early = await runCli(["promote", "--continue"], opts);
    assert.equal(early.json.stage, "await_policy_approval", "no canary before the policy approval");
    await personApproves(s2.json.approve_url);
    const s3 = await runCli(["promote", "--continue"], opts);
    assert.equal(s3.json.stage, "await_canary_approval", s3.stderr);
    await personApproves(s3.json.approve_url);
    const canary = await runCli(["promote", "--continue"], opts);
    assert.equal(canary.json.stage, "canary_live", canary.stderr);
    assert.equal(canary.json.details.canary_candidate_id, p2.json.candidate_id);
    const s4 = await runCli(["promote", "--continue", "--full"], opts);
    assert.equal(s4.json.stage, "await_full_approval", s4.stderr);
    await personApproves(s4.json.approve_url);
    const done = await runCli(["promote", "--continue"], opts);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.json.stage, "done");
    rmSync(work, { recursive: true, force: true });
  });
});
