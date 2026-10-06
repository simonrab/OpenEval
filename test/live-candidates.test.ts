import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { newEvalSetId, newPolicyId, newRecId } from "../src/ids.js";
import { createLiveSdk } from "../src/live/sdk.js";
import { mergeSettings, pickSystemPrompt } from "../src/live/request.js";
import {
  parseRuntimePolicyDocument,
  POLICY_FORMAT,
  promoteToLastFullIfNone,
  putPolicy,
  signPolicy,
  verifyPolicy,
  type PolicyModel,
  type RuntimePolicyDocument,
  type SignedPolicy,
  type UnsignedPolicy,
} from "../src/policy.js";
import { shapeProxyCall } from "../src/routes/proxy.js";
import type { ModelSettings } from "../src/runner/openrouter.js";
import { buildApp } from "../src/server.js";
import { evidenceBlockReason } from "../src/tools/live_automation.js";
import {
  authHeaders,
  seedFiveTrustedEvals,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";
import {
  createHopFetch,
  idForCanaryBucket,
  openRouterOk,
  type HopFetchCall,
} from "./helpers/live-demo.js";

const apiKey = TEST_API_KEY;
const openevalUrl = "http://test.local";
const vendorKey = "sk-or-v1-app-vendor-key";
const GOOD_JSON = '{"line_items":[{"sku":"a","qty":1}],"total_cents":100}';
const PROMPT = "Return JSON with line_items[] and total_cents.";
const WIN_PROMPT = "Return only JSON.";

type VendorBody = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning?: { effort: string };
  stream?: boolean;
};

function oldPolicy(projectId: string, modelId: string): UnsignedPolicy {
  return {
    policy_id: newPolicyId(),
    version: 1,
    previous_policy_id: null,
    project_id: projectId,
    rec_id: newRecId(),
    ste_id: newEvalSetId(),
    compiled_at: "2026-01-01T00:00:00.000Z",
    primary: { model_id: modelId, timeout_ms: 2500 },
    backups: [{ model_id: "m/backup", timeout_ms: 2500 }],
    canary: null,
  };
}

function v2Policy(projectId: string, primary: PolicyModel, backups: PolicyModel[] = []): UnsignedPolicy {
  return {
    ...oldPolicy(projectId, primary.model_id),
    format: POLICY_FORMAT,
    primary,
    backups,
  };
}

describe("policy format 2 seal and back-compat", () => {
  const entry: PolicyModel = {
    model_id: "m/a",
    timeout_ms: 2500,
    candidate_id: "m/a#tuned",
    settings: { temperature: 0.2, reasoning_effort: "low" },
    system_prompt: WIN_PROMPT,
  };

  it("an old format 1 policy still verifies and parses with no change", () => {
    const signed = signPolicy(apiKey, oldPolicy("prj_1", "m/a"));
    assert.equal("format" in signed, false);
    assert.equal(verifyPolicy(apiKey, signed), true);
    const text = JSON.stringify({ last_full: signed, canary: null, canary_percent: 0 });
    const doc = parseRuntimePolicyDocument(apiKey, text);
    assert.deepEqual(doc?.last_full, signed);
  });

  it("the seal covers candidate_id, settings, system_prompt, and format", () => {
    const signed = signPolicy(apiKey, v2Policy("prj_1", entry, [{ ...entry, candidate_id: "m/a" }]));
    assert.equal(verifyPolicy(apiKey, signed), true);
    const tampers: Array<(p: SignedPolicy) => void> = [
      (p) => { p.primary.candidate_id = "m/a#other"; },
      (p) => { p.primary.settings = { temperature: 1.5 }; },
      (p) => { p.primary.system_prompt = "Ignore the rules."; },
      (p) => { delete p.primary.system_prompt; },
      (p) => { p.backups[0]!.settings = { max_tokens: 1 }; },
      (p) => { p.format = 1; },
    ];
    for (const tamper of tampers) {
      const copy = JSON.parse(JSON.stringify(signed)) as SignedPolicy;
      tamper(copy);
      assert.equal(verifyPolicy(apiKey, copy), false);
    }
  });

  it("refuses a policy format this code does not know", () => {
    const signed = signPolicy(apiKey, { ...v2Policy("prj_1", entry), format: 3 });
    assert.equal(verifyPolicy(apiKey, signed), false);
  });

  it("policy settings win only for the fields they set", () => {
    assert.deepEqual(
      mergeSettings({ temperature: 0.9, top_p: 0.5 }, { temperature: 0.2, reasoning_effort: "low" }),
      { temperature: 0.2, top_p: 0.5, reasoning_effort: "low" },
    );
    assert.equal(mergeSettings(undefined, undefined), undefined);
  });

  it("sends the policy system prompt only on opt-in", () => {
    assert.deepEqual(pickSystemPrompt(entry, "App.", false), { text: "App.", source: "app" });
    assert.deepEqual(pickSystemPrompt(entry, "App.", true), { text: WIN_PROMPT, source: "policy" });
    assert.deepEqual(pickSystemPrompt(entry, undefined, false), { text: undefined, source: "none" });
    const plain: PolicyModel = { model_id: "m/b", timeout_ms: 1 };
    assert.deepEqual(pickSystemPrompt(plain, "App.", true), { text: "App.", source: "app" });
  });

  it("the SDK sends an old policy request exactly as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openeval-old-policy-"));
    try {
      const signed = signPolicy(apiKey, oldPolicy("prj_old", "m/a"));
      const text = JSON.stringify({ last_full: signed, canary: null, canary_percent: 0 });
      const bodies: string[] = [];
      const sdk = createLiveSdk({
        projectId: "prj_old",
        openevalUrl,
        openevalKey: apiKey,
        vendorKey,
        lastKnownPath: join(dir, "last-known.json"),
        applyPolicySystemPrompt: true,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.startsWith("https://openrouter.ai/")) {
            bodies.push(String(init?.body));
            return openRouterOk(GOOD_JSON);
          }
          if (url.includes("/runtime/policies/")) {
            return new Response(text, { status: 200 });
          }
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
      });
      await sdk.start();
      const result = await sdk.complete({ prompt: PROMPT });
      sdk.stop();
      assert.equal(
        bodies[0],
        JSON.stringify({ model: "m/a", messages: [{ role: "user", content: PROMPT }] }),
      );
      assert.equal(result.candidate_id, "m/a");
      assert.equal(result.system_prompt_source, "none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("guard evidence rules", () => {
  const base = { min_eval_pass_rate: 1, min_pass_rate_low: null, require_provider_cost: false };
  const evidence = {
    passRate: 1,
    trialPassRate: 0.93,
    passRateCi95: [0.7, 0.99] as [number, number],
    nTrials: 15,
    flakyCount: 1,
    costSource: "estimate",
    failingEvalIds: [],
  };

  it("keeps the current behavior when the new rules are unset", () => {
    assert.equal(evidenceBlockReason(base, evidence), null);
    assert.equal(evidenceBlockReason(base, { ...evidence, passRateCi95: null, costSource: null }), null);
  });

  it("min_pass_rate_low blocks a low or missing lower bound", () => {
    const rules = { ...base, min_pass_rate_low: 0.8 };
    assert.equal(evidenceBlockReason(rules, evidence), "eval_pass_rate_bound_low");
    assert.equal(evidenceBlockReason(rules, { ...evidence, passRateCi95: null }), "eval_pass_rate_bound_low");
    assert.equal(evidenceBlockReason(rules, { ...evidence, passRateCi95: [0.85, 1] }), null);
  });

  it("require_provider_cost blocks an estimated cost", () => {
    const rules = { ...base, require_provider_cost: true };
    assert.equal(evidenceBlockReason(rules, evidence), "eval_cost_not_provider");
    assert.equal(evidenceBlockReason(rules, { ...evidence, costSource: "provider" }), null);
  });
});

describe("proxy request shaping", () => {
  const entry: PolicyModel = {
    model_id: "m/a",
    timeout_ms: 2500,
    candidate_id: "m/a#tuned",
    settings: { temperature: 0.2, reasoning_effort: "low" },
    system_prompt: WIN_PROMPT,
  };
  const body = {
    messages: [
      { role: "system", content: "App prompt." },
      { role: "user", content: PROMPT },
    ],
    temperature: 0.9,
    top_p: 0.5,
    reasoning: { effort: "high" },
  };

  it("keeps the app prompt without opt-in and merges settings", () => {
    assert.deepEqual(shapeProxyCall(entry, body, false), {
      model: "m/a",
      systemPrompt: "App prompt.",
      settings: { temperature: 0.2, top_p: 0.5, reasoning_effort: "low" },
    });
  });

  it("uses the policy prompt with opt-in", () => {
    assert.equal(shapeProxyCall(entry, body, true).systemPrompt, WIN_PROMPT);
  });

  describe("route", () => {
    let app: FastifyInstance;
    let dir: string;
    let projectId: string;
    let calls: Array<{ model: string; systemPrompt?: string; settings?: ModelSettings }>;
    let failModel: string | null;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "openeval-proxy-v2-"));
      calls = [];
      failModel = null;
      app = await buildApp({
        sqlitePath: join(dir, "openeval.sqlite"),
        apiKey,
        baseUrl: openevalUrl,
        openRouterClient: {
          async chatCompletion(input) {
            calls.push({ model: input.model, systemPrompt: input.systemPrompt, settings: input.settings });
            if (input.model === failModel) {
              throw new Error("OpenRouter 503: down");
            }
            return { content: "ok", time_ms: 1, cost_usd: 0 };
          },
        },
      });
      const proj = await app.inject({ method: "POST", url: "/v1/projects", headers: authHeaders(), payload: {} });
      projectId = (proj.json() as { project_id: string }).project_id;
      const db = openDb(join(dir, "openeval.sqlite"));
      try {
        const last = putPolicy(db, apiKey, v2Policy(projectId, entry, [
          { model_id: "m/b", timeout_ms: 2500, candidate_id: "m/b#cold", settings: { temperature: 0 } },
        ]));
        promoteToLastFullIfNone(db, apiKey, projectId, last.policy_id);
      } finally {
        db.close();
      }
    });

    afterEach(async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    });

    async function send(headers: Record<string, string> = {}) {
      return app.inject({
        method: "POST",
        url: "/v1/proxy/chat/completions",
        headers: {
          ...authHeaders(),
          "x-openeval-project-id": projectId,
          "x-openrouter-api-key": vendorKey,
          ...headers,
        },
        payload: body,
      });
    }

    it("sends the base model, settings, and the prompt per opt-in", async () => {
      const res = await send();
      assert.equal(res.statusCode, 200, res.body);
      const out = res.json() as { model: string; openeval: { candidate_id: string } };
      assert.equal(out.model, "m/a");
      assert.equal(out.openeval.candidate_id, "m/a#tuned");
      assert.deepEqual(calls[0], {
        model: "m/a",
        systemPrompt: "App prompt.",
        settings: { temperature: 0.2, top_p: 0.5, reasoning_effort: "low" },
      });
      await send({ "x-openeval-apply-system-prompt": "true" });
      assert.equal(calls[1]?.systemPrompt, WIN_PROMPT);
    });

    it("falls back to the backup setup", async () => {
      failModel = "m/a";
      const res = await send();
      assert.equal(res.statusCode, 200, res.body);
      const out = res.json() as { model: string; openeval: { candidate_id: string } };
      assert.equal(out.model, "m/b");
      assert.equal(out.openeval.candidate_id, "m/b#cold");
      assert.deepEqual(calls[1]?.settings, { temperature: 0, top_p: 0.5, reasoning_effort: "high" });
    });
  });
});

describe("Live with candidate setups (end to end)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let keysRef: string;
  let failVendorModel: string | null;
  let hop: ReturnType<typeof createHopFetch>;
  const sdks: Array<ReturnType<typeof createLiveSdk>> = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openeval-live-candidates-"));
    sqlitePath = join(dir, "openeval.sqlite");
    failVendorModel = null;
    app = await buildApp({
      sqlitePath,
      apiKey,
      baseUrl: openevalUrl,
      openRouterClient: {
        async chatCompletion(input) {
          return {
            content: GOOD_JSON,
            time_ms: input.model === "m/a" ? 20 : 10,
            cost_usd: input.model === "m/a" ? 0.001 : 0.003,
            cost_source: "provider",
            prompt_tokens: 50,
            completion_tokens: 50,
          };
        },
      },
    });
    const proj = await app.inject({ method: "POST", url: "/v1/projects", headers: authHeaders(), payload: {} });
    projectId = (proj.json() as { project_id: string }).project_id;
    const db = new Database(sqlitePath);
    evalSetId = seedFiveTrustedEvals(db, projectId).evalSetId;
    keysRef = await storeCustomerKey(db, projectId);
    db.close();
    hop = createHopFetch({
      app,
      openevalUrl,
      isControlPlaneUp: () => true,
      vendorResponse: (model) => {
        if (model === failVendorModel) {
          failVendorModel = null;
          return new Response("vendor down", { status: 503 });
        }
        return openRouterOk(GOOD_JSON);
      },
    });
  });

  afterEach(async () => {
    for (const sdk of sdks.splice(0)) {
      sdk.stop();
    }
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function newSdk(applyPolicySystemPrompt: boolean, name: string) {
    const sdk = createLiveSdk({
      projectId,
      openevalUrl,
      openevalKey: apiKey,
      vendorKey,
      lastKnownPath: join(dir, `${name}.json`),
      pollMs: 30_000,
      fetch: hop.fetch,
      applyPolicySystemPrompt,
    });
    sdks.push(sdk);
    return sdk;
  }

  async function tool(name: string, payload: Record<string, unknown>) {
    const res = await app.inject({ method: "POST", url: `/v1/tools/${name}`, headers: authHeaders(), payload });
    assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  async function openUrl(path: string, approveUrl: string) {
    const params = Object.fromEntries(new URL(approveUrl).searchParams);
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/json", accept: "application/json" },
      payload: { ...params, decision: "approved" },
    });
    assert.equal(res.statusCode, 200, res.body);
  }

  /** run_evals, recommend_models, approve, compile_policy, approve. */
  async function evalToPolicy(candidates: unknown[], key: string) {
    const run = await tool("run_evals", {
      project_id: projectId,
      eval_set_id: evalSetId,
      candidates,
      reps: 3,
      max_eval_spend_usd: 5,
      keys_ref: keysRef,
      idempotency_key: `${key}-run`,
    });
    const runId = run.run_id as string;
    const report = await waitForRunComplete(app, projectId, runId);
    assert.equal(report.status, "succeeded");
    const rec = await tool("recommend_models", {
      project_id: projectId,
      eval_set_id: evalSetId,
      run_id: runId,
      intent: "new_feature",
      idempotency_key: `${key}-rec`,
    });
    await openUrl("/approve", rec.approve_url as string);
    const compiled = await tool("compile_policy", {
      project_id: projectId,
      recommendation_id: rec.recommendation_id,
      eval_set_id: evalSetId,
      idempotency_key: `${key}-compile`,
    });
    await openUrl("/compile-approve", compiled.approve_url as string);
    return { rec, compiled };
  }

  async function runtimeDoc(): Promise<RuntimePolicyDocument> {
    const res = await app.inject({
      method: "GET",
      url: `/v1/runtime/policies/${projectId}`,
      headers: authHeaders(),
    });
    assert.equal(res.statusCode, 200);
    return res.json() as RuntimePolicyDocument;
  }

  function vendorPosts(): HopFetchCall[] {
    return hop.calls.filter((c) => c.url.startsWith("https://openrouter.ai/"));
  }

  function lastVendorBody(): VendorBody {
    const posts = vendorPosts();
    return JSON.parse(posts[posts.length - 1]!.body ?? "{}") as VendorBody;
  }

  async function propose(intent: "canary" | "full" | "rollback") {
    const out = await tool("propose_rollout", {
      project_id: projectId,
      intent,
      idempotency_key: `propose-${intent}`,
    });
    await openUrl("/rollout-approve", out.approve_url as string);
    return out;
  }

  async function waitUntil(pred: () => boolean, label: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 2000) {
      if (pred()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out: ${label}`);
  }

  it("serves the setup that won the evals, then canary, full, and rollback by setup", async () => {
    const tuned = {
      id: "m/a#tuned",
      model: "m/a",
      settings: { temperature: 0.2, reasoning_effort: "low" },
      system_prompt: WIN_PROMPT,
    };
    const cold = { id: "m/b#cold", model: "m/b", settings: { temperature: 0 } };
    const first = await evalToPolicy([tuned, cold], "first");
    const named = first.rec.named_model as { id: string; backups: string[] };
    assert.equal(named.id, "m/a#tuned");
    assert.deepEqual(named.backups, ["m/b#cold"]);

    const compiled = first.compiled as {
      policy_id: string;
      format: number;
      primary: { candidate_id: string; model_id: string; settings: ModelSettings | null; has_system_prompt: boolean };
      system_prompt_note: string | null;
    };
    assert.equal(compiled.format, 2);
    assert.deepEqual(compiled.primary, {
      candidate_id: "m/a#tuned",
      model_id: "m/a",
      settings: tuned.settings,
      has_system_prompt: true,
    });
    assert.match(compiled.system_prompt_note ?? "", /applyPolicySystemPrompt/);

    const doc = await runtimeDoc();
    assert.equal(doc.last_full.policy_id, compiled.policy_id);
    assert.equal(doc.last_full.format, 2);
    assert.deepEqual(doc.last_full.primary, {
      model_id: "m/a",
      timeout_ms: 30000,
      candidate_id: "m/a#tuned",
      settings: tuned.settings,
      system_prompt: WIN_PROMPT,
    });
    assert.deepEqual(doc.last_full.backups, [
      { model_id: "m/b", timeout_ms: 30000, candidate_id: "m/b#cold", settings: { temperature: 0 } },
    ]);

    // Opt-in SDK: the policy prompt replaces the app prompt; policy settings win.
    const sdk = newSdk(true, "opt-in");
    await sdk.start();
    const served = await sdk.complete({
      prompt: PROMPT,
      system: "App prompt.",
      settings: { temperature: 0.9, top_p: 0.5 },
    });
    assert.equal(served.model_id, "m/a");
    assert.equal(served.candidate_id, "m/a#tuned");
    assert.equal(served.system_prompt_source, "policy");
    assert.deepEqual(lastVendorBody(), {
      model: "m/a",
      messages: [
        { role: "system", content: WIN_PROMPT },
        { role: "user", content: PROMPT },
      ],
      temperature: 0.2,
      top_p: 0.5,
      reasoning: { effort: "low" },
    });

    // Default SDK: the app prompt stays; the policy prompt is not sent.
    const plain = newSdk(false, "default");
    await plain.start();
    const kept = await plain.complete({ prompt: PROMPT, system: "App prompt." });
    assert.equal(kept.system_prompt_source, "app");
    assert.deepEqual(lastVendorBody().messages, [
      { role: "system", content: "App prompt." },
      { role: "user", content: PROMPT },
    ]);
    await plain.complete({ prompt: PROMPT });
    assert.deepEqual(lastVendorBody().messages, [{ role: "user", content: PROMPT }]);

    // Fallback uses the backup setup.
    failVendorModel = "m/a";
    const fell = await sdk.complete({ prompt: PROMPT });
    assert.equal(fell.candidate_id, "m/b#cold");
    assert.equal(lastVendorBody().model, "m/b");
    assert.equal(lastVendorBody().temperature, 0);

    // A second setup becomes an approved draft.
    const strict = { id: "m/b#strict", model: "m/b", settings: { temperature: 0, max_tokens: 512 } };
    const second = await evalToPolicy([strict], "second");
    const secondPolicyId = (second.compiled as { policy_id: string }).policy_id;
    assert.equal((await runtimeDoc()).last_full.policy_id, compiled.policy_id);

    const canary = await propose("canary");
    assert.equal(canary.from_candidate_id, "m/a#tuned");
    assert.equal(canary.to_candidate_id, "m/b#strict");
    const canaryDoc = await runtimeDoc();
    assert.equal(canaryDoc.canary?.policy_id, secondPolicyId);
    assert.equal(canaryDoc.canary?.primary.candidate_id, "m/b#strict");

    await sdk.start();
    const canaryUser = idForCanaryBucket(true);
    const fullUser = idForCanaryBucket(false);
    const onCanary = await sdk.complete({ prompt: PROMPT, user_id: canaryUser });
    assert.equal(onCanary.candidate_id, "m/b#strict");
    assert.equal(onCanary.policy_id, secondPolicyId);
    assert.deepEqual(lastVendorBody(), {
      model: "m/b",
      messages: [{ role: "user", content: PROMPT }],
      temperature: 0,
      max_tokens: 512,
    });
    const onFull = await sdk.complete({ prompt: PROMPT, user_id: fullUser });
    assert.equal(onFull.candidate_id, "m/a#tuned");

    // Samples and stats name the setup.
    await sdk.complete({ prompt: PROMPT, user_id: canaryUser });
    await sdk.reportMiss({ prompt: PROMPT, output: "bad" });
    const missPost = () =>
      hop.calls.find(
        (c) => c.url.includes("/v1/runtime/samples") && (c.body ?? "").includes("app_reported"),
      );
    await waitUntil(() => missPost() !== undefined, "sample upload");
    const sample = JSON.parse(missPost()!.body ?? "{}") as { candidate_id?: string; model_id: string };
    assert.equal(sample.candidate_id, "m/b#strict");
    assert.equal(sample.model_id, "m/b");
    await sdk.start();
    const statsPost = [...hop.calls].reverse().find((c) => c.url.includes("/v1/runtime/stats"));
    assert.equal((JSON.parse(statsPost!.body ?? "{}") as { candidate_id: string }).candidate_id, "m/b#strict");

    const report = await tool("get_live_report", { project_id: projectId });
    assert.equal(report.candidate_id, "m/a#tuned");
    assert.equal(report.canary_candidate_id, "m/b#strict");
    const samples = report.samples as Array<{ why: string; candidate_id: string | null }>;
    assert.equal(samples.find((x) => x.why === "vendor_error")?.candidate_id, "m/a#tuned");
    assert.equal(samples.find((x) => x.why === "app_reported")?.candidate_id, "m/b#strict");

    // Full: every user gets the second setup.
    const full = await propose("full");
    assert.equal(full.to_candidate_id, "m/b#strict");
    await sdk.start();
    const afterFull = await sdk.complete({ prompt: PROMPT, user_id: fullUser });
    assert.equal(afterFull.candidate_id, "m/b#strict");
    assert.equal(lastVendorBody().temperature, 0);

    // Rollback: the first setup comes back with its settings and prompt.
    const rollback = await propose("rollback");
    assert.equal(rollback.from_candidate_id, "m/b#strict");
    assert.equal(rollback.to_candidate_id, "m/a#tuned");
    await sdk.start();
    const rolled = await sdk.complete({ prompt: PROMPT, user_id: canaryUser });
    assert.equal(rolled.candidate_id, "m/a#tuned");
    assert.deepEqual(lastVendorBody(), {
      model: "m/a",
      messages: [
        { role: "system", content: WIN_PROMPT },
        { role: "user", content: PROMPT },
      ],
      temperature: 0.2,
      reasoning: { effort: "low" },
    });
  });

  it("compile_policy refuses a recommendation from an optimize run", async () => {
    const first = await evalToPolicy([{ id: "m/a", model: "m/a" }], "opt");
    const db = openDb(sqlitePath);
    try {
      db.prepare(
        `UPDATE runs SET intent = 'optimize'
         WHERE id = (SELECT run_id FROM recommendations WHERE id = ?)`,
      ).run(first.rec.recommendation_id);
    } finally {
      db.close();
    }
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/compile_policy",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        recommendation_id: first.rec.recommendation_id,
        eval_set_id: evalSetId,
        idempotency_key: "opt-compile-again",
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { code: string }).code, "INVALID_INPUT");
  });

  it("autopilot blocks a canary when the pass rate bound or cost source rule fails", async () => {
    await evalToPolicy([{ id: "m/a", model: "m/a" }], "base");
    await evalToPolicy([{ id: "m/b#x", model: "m/b", settings: { temperature: 0 } }], "next");
    const db = openDb(sqlitePath);
    try {
      db.prepare(`UPDATE recommendations SET cost_source = 'estimate'`).run();
    } finally {
      db.close();
    }
    async function cycle(rules: Record<string, unknown>, key: string) {
      await tool("configure_live_automation", {
        project_id: projectId,
        mode: "guarded",
        guard_rules: { auto_canary: true, ...rules },
        approved_by: "per_admin",
        idempotency_key: `cfg-${key}`,
      });
      return tool("run_live_decision_cycle", { project_id: projectId, idempotency_key: `cyc-${key}` });
    }
    assert.equal((await cycle({ min_pass_rate_low: 0.99 }, "bound")).blocked_reason, "eval_pass_rate_bound_low");
    assert.equal((await cycle({ require_provider_cost: true }, "cost")).blocked_reason, "eval_cost_not_provider");
    assert.equal((await cycle({ allowed_models: ["m/b#y"] }, "setup")).blocked_reason, "model_not_allowed");
    const done = await cycle({ allowed_models: ["m/b"], min_pass_rate_low: 0.5 }, "ok");
    assert.equal(done.pending_action, "auto_canary");
    assert.equal((await runtimeDoc()).canary?.primary.candidate_id, "m/b#x");
  });
});
